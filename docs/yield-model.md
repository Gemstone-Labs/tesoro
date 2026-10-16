# Simulated yield model: per-Position, linear

Decided 2026-10-03 (founder: "Per-Position yield"). Rationale and rejected options: `docs/adr/0005-per-position-simulated-yield.md`.

## Rule

Every Position earns, from the moment it opens:

```
yield(t) = principal * apy * simulated_elapsed(t) / year          simulated_elapsed = real_elapsed * speedup
```

linear on its own Principal (no compounding), on every chain. Tesoro takes the **Yield Fee** (20%, ADR 0007) out of every increment, so the Position itself earns 80% of this: `net(t) = yield(t) - floor(yield(t) * 2000 / 10000)` per increment. `apy` is the Position's own `rate_bps` (set at open from the pool); `speedup` is 4,380 (1 simulated month = 1/12 year = 600 real seconds; the old 4,320 is 30 days per 600 s, which repaid an N-month Advance after about N x 10.14 minutes). An Advance of `N` months is 80% of the projected yield, `principal * apy * N / 12 * 0.8`; the Position earns 80% too, so it is still repaid in exactly `N * 10` minutes for every Position.

The LST exchange rate (`sim_lst` Pool rate, `SimLST.underlyingPerShare()`) is **constant**. It stays at the value it had when the model changed, so existing simSOL / simETH keeps its underlying value. Deposit and withdraw price at that constant rate.

## How yield becomes real tokens

Since ADR 0010 Solana yield is **computed, never cranked**, and minted only when it is paid:

1. Every native instruction that needs Debt or a redeemable amount computes `Accrued Yield = Principal x (growth - 1)` at the clock with `ledger/yield_math.rs` (`growth = 1 + rate_bps x elapsed x speedup / (10,000 x year)`; `growth_since_open` is the one network-specific call), minus the Yield Fee.
2. The open Advance counts `min(net - applied_net, units owed)`. `applied_net` is a per-Position checkpoint (settled yield: consumed by closed Sources or banked as free yield), so a later Advance never counts yield from before it opened. See `docs/tesoro-core.md`.
3. At payout (Redeem, the free yield at Unlock) tesoro_core CPIs `sim_lst::mint_yield` for exactly the SOL value paid. `mint_yield` is callable only by the recorded yield authority, the tesoro_core PDA `["yield"]` (`set_yield_authority`, PDA `["yield_config"]`). Principal returns from one shared vault.
4. The Yield Fee is not minted per increment: the Treasury's claim is computed from pool totals (`P`, `PT`, realised fees) that change only on open and unlock.
5. Accrual stops at Unlock (the Position leaves the totals).

EVM (`SimLST` + `PositionVault`): same rule. `SimLST` rate frozen, with a `minter` (the vault). The vault's `accrue(id)` (run at the start of `reportYield`, also public) mints `principalUnderlying * apyBps * dt * speedup / (BPS * YEAR)` worth of shares into itself and adds them to `heldShares`; the existing `_accrued` (paid + value of shares above the Principal reserve) is unchanged. The real-wstETH vault has no minter and keeps real wstETH yield.

## Reserve

Minted yield shares are not backed by deposited SOL/ETH: withdrawals are paid from the admin-funded reserve (`fund_reserve` / ETH sent to `SimLST`). A Position's total reserve claim is bounded by `principal * apy * (horizon_months / 12)` while Debt is outstanding. At 7% APY and a 1-month Advance that is `0.58%` of Principal per Position. Positions that stay Locked after Debt reaches 0 keep accruing free yield (`principal * 0.83` per real day at 4,320x), which is only drawn from the reserve if the owner withdraws it.

## Migration

* Solana `Pool`: no layout change. `set_params` is run once on the old program to checkpoint `base_rate` at the then-current rate; the new `current_rate` returns `base_rate`.
* Solana native Positions (ADR 0010): fresh start. `NativeCustody` is now a singleton `["native"]` with a shared vault `["native_vault"]`; `Position` gained `opened_at`, `applied_net`, `custody_shares`. Old per-Position custodies and vaults are not migrated (`migrate_native_custody` is gone) and are closed by an admin script.
* EVM: contracts are redeployed (constructor/ABI change). Old Hoodi/HyperEVM test Positions on the previous vaults are abandoned; see `docs/deployments.md`.

## App

One function (`app/src/lib/chain/yield.ts`) gives accrued yield for a Position at time `t` from `(principal, rateBps, sinceSec, speedup)`. The quote, Unlock Estimate, projected Debt and charts all use it. A fresh Advance of N months reads `N * 10` minutes.

## Real staking tokens (mainnet, ADR 0010)

Test mode above is unchanged. On a mainnet-configured cluster the Position token is an SPL stake pool token (jitoSOL today) and nothing is minted:

* **Rate.** `total_lamports / pool_token_supply` of the `StakePool` account, 1e9 fixed point. The account must be owned by an SPL stake pool program (`STAKE_POOL_PROGRAMS`) and name the token as its pool mint.
* **Open.** `open_stake_pool_position(nonce, token_amount)` requires the `["sol_source"]` setting (mint and pool) and the token's published APY `["token_apy", mint]` (`set_token_apy`, oracle authority, at most 100%). Principal = tokens x rate; `rate_bps` = `min(published APY, ceiling)`. The custody is allocated `NativeCustody::STAKE_POOL_SPACE` (the live layout plus a marker byte and the rate high-water mark), so no live account changes.
* **Trailing APY under a ceiling.** `TokenApy` (`["token_apy", mint]`, 53 bytes with discriminator) holds `apy_bps` and `updated_ts` (oracle authority only, `set_token_apy`, at most 100%) and `ceiling_bps` (admin only, `set_token_apy_ceiling`, at most 100%; 0 until set, which sizes nothing). The keeper samples the pool's rate daily (30 days kept in `KEEPER_STATE_DIR/stake-apy-<mint>.json`), publishes the linear trailing APY (growth over the span scaled to a year) once it has at least 7 days of samples, and republishes about daily. Advances and Extends on a real token **re-read** `min(published, ceiling)` into `position.rate_bps` (the `TokenApy` is the first remaining account and cannot be left out) and refuse a published APY older than 3 days (`StaleApy`) or an unset ceiling (`ApyCeilingNotSet`). So Advances follow reality: an Extend mints `size(h + e) - size(h)` at the current rate, never a windfall from a rate change. The stored rate also feeds the Unlock Estimate, so it always shows the rate of the latest Advance or Extend. A simSOL Position is untouched. ETH and HYPE vault APY publishing is out of scope for this ticket.
* **Yield.** `accrue_stake_pool_yield` (permissionless) takes the Yield Fee on the rate's growth since the high-water mark: `fee_bps` of the growth, paid in tokens from the Position's vault to the Treasury vault of that token (`["treasury_vault", mint]`, created by the admin with `init_treasury_vault`), and out of `tracked_shares`. The Position keeps the rest; cumulative yield is still `tracked_shares * rate - principal + redeemed`. The same fee is settled inside Unlock and sweep (they pass `[treasury, treasury_vault]` as two extra remaining accounts), so surplus never leaves untaxed.
* **Out.** Redeem and Unlock pay the token. Instant Redeem pays from the Treasury vault of the Position's token, priced by the pool passed as `pool`.
