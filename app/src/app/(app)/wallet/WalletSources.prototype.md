# Wallet with hundreds of Sources — design study

Status: unvalidated exploration, 2026-10-17. No production decision or integration.

Question: how can a Player understand and act on hundreds of Gema Sources without managing each one?

## Domain finding

Wins and Leaderboard payouts transfer Gemas retaining their Source, not ownership of the originating Position. A Player can therefore have three owned Positions and hundreds of Sources. The existing Wallet already separates owned Position tiles from Pending by Source, but the latter grows one row per Source and the headline figures do not fully explain available-to-play versus pending redemption.

Sources: CONTEXT.md (Position, Source, Pot, Redeem); ADR 0001; wallet/page.tsx; NativePositions.tsx; EthPositions.tsx. Existing ETH/HYPE redemption already loops over holdings: grouping a review does not prove one atomic payout or one signature. ADR 0001 requires redeemable versus pending per Source; preserve this via inspectable details.

## Three hypotheses

A — Action-first: lead with Available to play, Redeemable now, Pending redemption. Asset summaries underneath; owned Positions separate. Best candidate for the default because it answers the Player's next decision before exposing the ledger. Risk: these figures overlap. Pending is a redemption state, not an inability to play; reserved Gemas are excluded from available-to-play. Explain the overlap explicitly.

B — Redemption assets: three asset/network groups, each with ready, pending, payout amount, and expandable Sources. Useful for Players deciding which asset to receive. Risk: demands chain knowledge early and makes a shared play unit feel fragmented. Candidate for a Redeem screen, rather than the default Wallet.

C — Source explorer: compact rows, search by ID or reward origin, filters, pagination, detail sheet. Useful for experienced Players and support. Risk: 240 rows still imply 240 things to manage. Candidate for an optional All Sources view.

Recommendation to evaluate: A as the default, B inside redemption review, C behind View Sources. Recommendation only; no winner approved.

## Other ideas worth discussing

- Group repeated wins from the same Source into one holding. Keep individual game/Season receipts in Activity, not additional Wallet cards. Verify the current ledger already coalesces this before treating it as a new backend feature.
- Auto-collapse fully redeemed, zero-holding Sources into History; retain access to receipts. Tiny holdings should be summarized with their total and count, never silently hidden.
- Surface exceptions: a payout awaiting completion, an unavailable estimate, or a Treasury capacity problem. Do not turn ordinary pending yield into an alert. There is no guaranteed maximum wait.
- Offer a single redemption review which groups eligible amounts by asset, network and destination. Show costs, net receipts, reserved exclusions, and any separate signatures/transactions. Persist per-operation progress in real implementation; retries must not repeat completed payouts.
- Offer Instant Redeem as an explicit comparison with waiting, including fee, payout per asset, Treasury capacity, and source eligibility. Never auto-select it to tidy the list.
- Let Players opt into a useful ready-to-redeem digest or threshold. Avoid one notification per Source. Automatic redemption is a separate authorization/fees/retry design, not part of this prototype.
- Use pagination or virtualization for detail lists; a production summary must cover all holdings, not only the fetched page. Source-level asset amounts must be summed using each Source's issuance rate, not one conversion rate for all Gemas.
- Do not merge Sources on chain, swap assets, change their claim priority, or reuse won Gemas to shorten the winner's own lock merely to simplify the display.

## Run and inspect

From this worktree: `pnpm prototype:wallet`.

- http://localhost:3317/wallet?prototype=sources&variant=A
- http://localhost:3317/wallet?prototype=sources&variant=B
- http://localhost:3317/wallet?prototype=sources&variant=C

Floating arrows or left/right keys switch views; text fields retain their normal keys. Without prototype=sources, /wallet renders the original page. The experiment is development-only.

Fixture: 240 won Sources, 3 owned Positions, 45,000 Gemas total, 4,500 redeemable, 40,500 pending, 375 reserved, 44,625 available to play. The app shell retains its separate offline fixture. Amounts, rates, Positions and payout completion are fictional; no chain mutations. Current state and all 240 Sources are inspectable at the bottom. Refresh resets state.

The Instant Redeem comparison assumes a sample 25% fee. Local workspace deployment notes say this changed on Oct 16; CONTEXT.md and ADR 0007 at origin/main 7a36d4f still say 35%. This study does not resolve that documentation mismatch or assert a live quote. Real review must read the configured fee.

## Review tasks

1. You won a Season payout. Without opening any Source, how many Gemas can you play with? How many can you redeem now?
2. Inspect a partly redeemable Source. Explain what happens to its remaining Gemas and which asset it pays.
3. Preview all redeemable Gemas. Can you tell that you receive three assets, and that one completed network does not complete the others?
4. Find SRC-0141 or only Leaderboard Sources. Does this detail belong on the default screen?
5. Find your own Principal. Is it clear that winning more Gemas does not give you another Player's Position or repay yours?

No user validation collected yet. Batch execution reliability, full-ledger aggregation performance, fees, live Quotes and wallet confirmations remain implementation work.

## Verification

TypeScript no-emit, scoped ESLint and git diff whitespace check passed. Browser-driven review at 1440x1050 and 390x844; all three variants captured, with no horizontal overflow at phone width. Verified URL variant switching, search for SRC-0141 and preservation of arrow-key text editing, and simulated SOL completion leaving ETH/HYPE independently actionable. No live transaction or production build validation. Screenshots: workspace docs/internal/screens/wallet-sources-prototype/. First navigation timed out during compilation; the page subsequently loaded successfully.
