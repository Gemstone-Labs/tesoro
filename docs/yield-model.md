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

Yield is minted, not read off a growing rate:

1. `accrue_native_yield` (Solana, permissionless, keeper cranks it) computes `units = principal * apy_bps * dt * speedup / (10_000 * 31_536_000)` SOL base units since the custody's `last_accrual_ts`, converts to shares at the constant rate (`floor(units * 1e9 / rate)`), and CPIs `sim_lst::mint_yield` to mint them into the Position's vault. If the floor gives 0 shares the timestamp does not advance, so time carries over.
2. `sim_lst::mint_yield` is callable only by the recorded yield authority: the tesoro_core PDA `["yield"]`, registered once by the sim_lst admin (`set_yield_authority`, PDA `["yield_config"]`). tesoro_core validates the sim_lst program id and pool before the CPI.
   The mint is split: 80% of the shares go to the Position vault, 20% to the Treasury vault (EVM: `treasuryShares` inside the vault).
3. Custody accounting is unchanged: `accrued = vault_shares * rate - principal + redeemed`. Because the rate is constant, accrued only grows through minting, so every unit of accrued yield is a share in the vault and a Redeem is always covered.
4. Accrual stops at Unlock (no yield on a closed Position).

EVM (`SimLST` + `PositionVault`): same rule. `SimLST` rate frozen, with a `minter` (the vault). The vault's `accrue(id)` (run at the start of `reportYield`, also public) mints `principalUnderlying * apyBps * dt * speedup / (BPS * YEAR)` worth of shares into itself and adds them to `heldShares`; the existing `_accrued` (paid + value of shares above the Principal reserve) is unchanged. The real-wstETH vault has no minter and keeps real wstETH yield.

## Reserve

Minted yield shares are not backed by deposited SOL/ETH: withdrawals are paid from the admin-funded reserve (`fund_reserve` / ETH sent to `SimLST`). A Position's total reserve claim is bounded by `principal * apy * (horizon_months / 12)` while Debt is outstanding. At 7% APY and a 1-month Advance that is `0.58%` of Principal per Position. Positions that stay Locked after Debt reaches 0 keep accruing free yield (`principal * 0.83` per real day at 4,320x), which is only drawn from the reserve if the owner withdraws it.

## Migration

* Solana `Pool`: no layout change. `set_params` is run once on the old program to checkpoint `base_rate` at the then-current rate; the new `current_rate` returns `base_rate`.
* `NativeCustody`: `last_accrual_ts: i64` appended (LEGACY → V2 (`tracked_shares`) → V3). `migrate_native_custody` takes either older layout and sets `last_accrual_ts = now`; live Positions earn at the new rate from the upgrade time. Debt already repaid by the old fast yield stays repaid.
* EVM: contracts are redeployed (constructor/ABI change). Old Hoodi/HyperEVM test Positions on the previous vaults are abandoned; see `docs/deployments.md`.

## App

One function (`app/src/lib/chain/yield.ts`) gives accrued yield for a Position at time `t` from `(principal, rateBps, sinceSec, speedup)`. The quote, Unlock Estimate, projected Debt and charts all use it. A fresh Advance of N months reads `N * 10` minutes.

## Real staking tokens (mainnet, ADR 0010)

Test mode above is unchanged. On a mainnet-configured cluster the Position token is an SPL stake pool token (jitoSOL today) and nothing is minted:

* **Rate.** `total_lamports / pool_token_supply` of the `StakePool` account, 1e9 fixed point. The account must be owned by an SPL stake pool program (`STAKE_POOL_PROGRAMS`) and name the token as its pool mint.
* **Open.** `open_stake_pool_position(nonce, token_amount)` requires the `["sol_source"]` setting (mint and pool) and the token's published APY `["token_apy", mint]` (`set_token_apy`, oracle authority, at most 100%). Principal = tokens x rate; `rate_bps` = the published APY. The custody is allocated `NativeCustody::STAKE_POOL_SPACE` (the live layout plus a marker byte and the rate high-water mark), so no live account changes.
* **Yield.** `accrue_stake_pool_yield` (permissionless) takes the Yield Fee on the rate's growth since the high-water mark: `fee_bps` of the growth, paid in tokens from the Position's vault to the Treasury vault of that token (`["treasury_vault", mint]`, created by the admin with `init_treasury_vault`), and out of `tracked_shares`. The Position keeps the rest; cumulative yield is still `tracked_shares * rate - principal + redeemed`. The same fee is settled inside Unlock and sweep (they pass `[treasury, treasury_vault]` as two extra remaining accounts), so surplus never leaves untaxed.
* **Out.** Redeem and Unlock pay the token. Instant Redeem pays from the Treasury vault of the Position's token, priced by the pool passed as `pool`.
