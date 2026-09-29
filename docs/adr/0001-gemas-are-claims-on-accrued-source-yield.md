# A Gema is a claim on its Source's accrued yield, fixed in the Source asset

Gemas from three chains share one table, so we had to decide what a won unit is worth and who guarantees it. Decided (2026-09-29): a Gema is valued in dollars only at issuance, then fixed as an amount of its Source Position's asset; it redeems only as that Position's yield actually accrues; all accrued yield on a Position with Debt repays that Debt automatically, and no new Advance opens until Debt is zero. Principal never pays Debt — not by top-up, not by re-sourcing — so a loser's only exits are waiting for yield or returning their own unspent Gemas.

## Considered Options

- **Non-redeemable game currency** — simplest and fully conserved, but winning would mean nothing beyond unlocking sooner.
- **Dollar-denominated claims with a live oracle** — the loser's lock would float with their asset's price.
- **User-paced repayment** — lets a loser keep minting new Advances while winners' claims wait indefinitely.
- **Re-sourcing** (returning anyone's Gemas reassigns claims to pay down your own Debt) — conserved, but moves winners onto slower Sources without consent; rejected in favour of "winning never shortens your own lock."

## Consequences

A winner may hold a basket of claims redeemable on several chains at different speeds; the UI must show redeemable-now versus pending per Source. A Source whose yield collapses leaves its Gema holders waiting without limit — accepted.
