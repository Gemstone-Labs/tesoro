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

## Real staking tokens (mainnet, ADR 0011)

Test mode above is unchanged. On mainnet the same formula applies (ADR 0010) with *growth since open* = the staking token's Staking Rate now / at open, read on chain inside the instruction:

```
Staking Rate = stake pool total_lamports * 1e12 / pool_token_supply      (lamports per pool token)
growth       = Staking Rate now / Staking Rate when the Position opened
Accrued Yield = Principal x (growth - 1), minus the Yield Fee            (Principal in lamports at the rate of the open)
```

- The pool account is passed into each instruction and checked: the custody's pool, owned by an allowed stake pool program, the token's mint, last updated within one epoch. No keeper job, no published APY.
- Debt is in lamports; Redeem, Unlock and Instant Redeem convert to the token at the rate of that moment (rounded down) and pay from the shared per-token vault. Nothing is minted.
- Advance sizing: the pool's last-epoch growth (current rate vs the rate one update earlier) scaled to a year, capped by the admin's ceiling (`set_stake_apy_ceiling`). The Unlock Estimate is an estimate: the app projects growth at that sizing APY.
- Price: Pyth sponsored SOL/USD feed through the admin's `onchain_price` mapping keyed by the token's mint. The keeper's price job is test mode only.
- Open with the token or with plain SOL (the pool's `DepositSol`, then the open for the quoted tokens less 0.5%, one transaction).
- Details, accounts and the Treasury in tokens: `docs/tesoro-core.md` ("Mainnet SOL Positions on a staking token"). The first draft of this section (per-Position stake-pool custody, `accrue_stake_pool_yield`, keeper-published `TokenApy`) was removed on 2026-10-16.
