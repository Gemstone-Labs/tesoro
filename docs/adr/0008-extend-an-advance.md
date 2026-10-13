# A Player can Extend an open Advance instead of waiting for it to be repaid

Decided (founder, Oct 13, 2026). A Player who loses the Gemas of their first Advance could not play again until the Advance was repaid, up to 12 months. A Position holds one open Advance and takes another only at Debt 0, so they were benched. **Extend** lets the Player commit more of the Position's future yield on the same Advance.

## How it is built

- `extend_native_advance(extra_months)` on `tesoro_core`, SOL Positions only. The owner signs alone. Accounts: owner, owner Account, Position, Treasury (read for the Yield Fee), the open Source, the owner's Holding of it.
- Preconditions: Position Locked; the Position's open Advance is this Source; the Source's Debt is above zero (`AdvanceRepaid` otherwise, `NoOpenAdvance` once it is closed); `extra_months >= 1`; `horizon_months + extra_months <= 12` (`InvalidHorizon`).
- Gemas minted = `size(total) - issued`, where `size(m)` is the Advance sizing formula (`principal * rate_bps * m * (10000 - yield_fee) / (12 * 10000 * 10000)` units, converted at the Source's price, floored). `issued` therefore always equals one Advance of the whole Horizon, and extending twice by 3 equals extending once by 6.
- `Source.issued` and `Source.horizon_months` grow; the Gemas are credited to the owner's Holding as own-Sourced Gemas. No new account space: `horizon_months` already records the months advanced.
- The Position accrues yield from its start, so a Source extended to `h` months is repaid `h * 10` simulated minutes after the Position opened. The Unlock Estimate moves out by the added months.
- Event `AdvanceExtended`. Error `AdvanceRepaid` is appended at the end of the ledger errors; no code shifts.

## Considered Options

- **A second open Advance**: rejected. It breaks the one-open-Advance rule and the Debt accounting that depends on it (`apply_yield` repays one Source).
- **Re-pricing the added months at the current price**: rejected. A Source has one price; mixing two inside it would make a Gema of one Source worth different amounts.
- **Extending at Debt 0**: not needed. The Player takes another Advance on the same Principal.

## Consequences

- Requires a `tesoro_core` upgrade on devnet; the app shows the action only once `NEXT_PUBLIC_EXTEND_ADVANCE=1`.
- ETH and HYPE Positions have no Extend: the EVM vaults and the bridge are unchanged.
- A Player who extends owes the added months before Unlock; the Principal is locked for the total Horizon.
