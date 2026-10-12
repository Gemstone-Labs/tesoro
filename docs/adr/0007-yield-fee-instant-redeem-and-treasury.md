# Tesoro takes a 20% Yield Fee and sells Instant Redeem at 65% from a Treasury

Decided (founder, Oct 12, 2026). Tesoro had one revenue, the Platform Fee on Matches. It now has three. The **Yield Fee**: 20% of every increment of staking yield a Position earns (SOL, ETH, HYPE), never Principal. The **Instant Redeem Fee**: a holder of won Gemas may redeem now, before the Source's yield has landed, for 65% of their value; Tesoro keeps 35%. A **Treasury** is the counterparty: it pays the 65% now, takes the Gemas, and redeems them at full value later as the Source's yield lands.

## How it is built

- **Yield Fee.** `yield_fee_bps = 2000` (cap 5000). A Position keeps `units - floor(units * fee / 10000)` of each yield increment, so it earns 80% of `principal * apy * t`. The Advance is sized at 80% of projected yield, `floor(principal * rate_bps * months * (10000 - fee) / (12 * 10000 * 10000))`, so it still repays in exactly `months * 10` minutes and the Unlock Estimate is unchanged.
- **Instant Redeem.** `units = floor(gemas * unit_num / unit_den)` as in Redeem, `payout = floor(units * (10000 - instant_fee_bps) / 10000)`, `instant_fee_bps = 3500` (cap 5000). Only won (`is_own == false`), free Gemas. They move from the holder's Holding to the Treasury Account's Holding of the same Source; the Source's Debt, outstanding and redeemable counts do not change.
- **Solana Treasury.** A `Treasury` PDA `["treasury"]` holds the two rates, a simSOL treasury vault (`["treasury_vault"]`) and a Treasury Account (a `TesoroAccount` whose authority is the Treasury PDA, so nobody can sign for it). `accrue_native_yield` mints 80% of the yield into the Position vault and 20% into the treasury vault. `instant_redeem` pays simSOL from the vault in the same transaction and fails `TreasuryShort` when it holds less. `redeem_treasury` (permissionless) redeems the Treasury Account's Gemas under the normal Redeem rules and the simSOL lands back in the vault.
- **EVM Treasury.** The vault takes the fee at the source: on accrue, 20% of the minted shares go to `treasuryShares` and `treasuryIn += value`; `fundTreasury(shares)` is the owner's top-up. `reportYield` reports `(accrued, treasuryIn)`: `YieldAccrued` grows from 61 to **77 bytes** (`treasury_in u128` appended). The new outbound message **`PayInstant` (type 5, 93 bytes, same layout as PayYield)** pays from the vault treasury; `InsufficientTreasury` reverts and stays retryable; payouts are idempotent per (id, seq).
- **Solana-side cap.** The bridge mirrors each vault's treasury in `VaultTreasury` (`["treasury", eid, vault]`: `reported_in`, `instant_recorded`). `instant_redeem_to_evm` refuses (`TreasuryShort`) unless `instant_recorded + payout <= reported_in`, then records the payout. That is safe because `treasuryIn` only grows and only Instant Redeem spends the vault treasury, so the mirror can never over-promise. For the same reason no treasury withdrawal exists yet.
- **Refill loop.** `redeem_treasury_to_evm` records a normal `Claim` for the Treasury Account; `send_pay_yield` then sends `PayYield` with `to == vault`, which the vault books into its treasury (`treasuryIn` grows, `sync_treasury` / the next `apply_yield` raise `reported_in`). The Treasury Account's Gemas therefore turn back into spendable treasury as the Source's yield lands.
- **Funding.** The owner funds each Treasury (`fund_treasury` on Solana, `fundTreasury` on a vault). Instant Redeem is limited by what the Treasury holds.

## Considered Options

- **Charge the fee on Solana for EVM Positions**: rejected. The Position's yield would be reported gross and the fee settled later, so the vault would pay out yield it still owes to Tesoro. Taking it at the source keeps each chain's books closed.
- **One pooled cross-chain Treasury**: rejected. It needs a Solana-to-EVM payout for every Instant Redeem and a shared balance nobody can verify from the other side. A treasury per vault, mirrored by a monotonic counter, is enforceable on both sides.
- **Let the relayer decide payouts**: rejected. Payouts must be enforced by contracts; the relayer only delivers messages.

## Consequences

- Every `BridgePosition` changes layout (`treasury_in` appended after `unlock_sent`) and no longer decodes. The old EVM vaults speak the 61-byte `YieldAccrued`, which the new bridge refuses: those vaults and their Positions are abandoned (beta, accepted). New vaults are deployed and `SimLST.setMinter(newVault)` is set.
- Clients of `accrue_native_yield`, `take_advance`, `take_native_advance`, bridge `apply_yield`, `set_peer_config` and `send_pay_yield` must use the new account lists (`docs/tesoro-core.md`, `docs/cross-chain.md`).
- Existing SOL Positions keep their layout, but an Advance already sized at 100% now repays at 80% of the rate: its Unlock comes 25% later than estimated.
- Treasury revenue cannot be withdrawn yet. It is spent only by Instant Redeem and refilled by redeeming the Gemas it bought.
- Instant Redeem is limited by Treasury liquidity: a large request can fail until the Treasury is funded or refilled.
- Tesoro carries the timing risk: if a Source's yield slows, the Treasury waits longer for its Gemas to become redeemable.

Details: `docs/tesoro-core.md`, `docs/cross-chain.md`, `docs/yield-model.md`.
