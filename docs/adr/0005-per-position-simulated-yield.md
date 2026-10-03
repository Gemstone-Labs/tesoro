# Simulated yield is linear on each Position's own Principal, not on the LST exchange rate

The simulated yield clock ran 4,320x (1 month = 10 minutes) through a growing LST exchange rate with simple interest on the pool's original base rate. An Advance is sized as `principal_now * apy * months / 12`, where `principal_now` includes the rate growth, but yield per second stays 7% of the *original* 1.0. Devnet reached 3.72 SOL per simSOL by Oct 3 (+0.83/day), so a 1-month Advance took about 37 minutes to repay instead of 10, and 12 months about 448 minutes, worse every day. Decided (founder, Oct 3, 2026): each Position earns `principal * apy * simulated_time` from its own open time, and the LST rate stops growing.

## Considered Options

- **Compounding rate**: rejected. At this speed-up it reaches about 7,000 SOL per simSOL by Oct 12 and overflows u64 in about three weeks.
- **Rebasing the Advance to the original rate**: rejected. Same mismatch on EVM, and it prices an Advance against a value nobody holds.
- **Per-Position linear yield minted into the vault (chosen)**: exact repayment time for every Position and Horizon, constant rate so existing balances keep their value, custody accounting unchanged. Costs a CPI per crank and an admin-set mint authority; yield shares are backed by the simulated reserve.

Details: `docs/yield-model.md`.
