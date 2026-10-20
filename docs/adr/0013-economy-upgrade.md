---
status: accepted
---

# Cheap Matches, fees paid first, one basket per Account, half the Yield Fee to the Pool

Decided (founder, Oct 20, 2026).

Measured on devnet, a Hold'em Match left about 0.026 SOL ($3.92) on chain while Tesoro earns $0.10 to $0.50 per Match. Fees reached Tesoro as Gemas that turn into SOL over up to 12 months. Gemas from different Sources looked equal but were not, and the program let the client pick which ones to bet. The Leaderboard Pool got only the 1% Leaderboard Fee. Game registration could overwrite an existing Game. This ADR changes all of that in one `tesoro_core` upgrade, before mainnet, while nobody plays.

## The model

- **Tables that stay on MagicBlock.** Each table Game (Hold'em, Trading Duel, Vanguard) keeps a capped set of tables, delegated once and never undelegated.
  - A Match is bound write-once to one table, generation and epoch.
  - Only the public table is committed; the result stays in a ring until a core settlement receipt proves it is no longer needed.
  - Hidden seat data lives in rollup-only accounts.
  - MatchState closes after settlement, and Match history moves to our database from core events.
  - Players never delegate.
- **Tesoro sponsors Players' SOL.** A server-built allow-list, a core-owned sponsor PDA, admission limits and a reserved exit budget.
- **Exact per-line bookkeeping** (Liquity's product-and-sum method, with scale and epoch).
  - Yield landing on a Source after a fee arrives covers, in order:
    1. the Platform Fee;
    2. Studio Fees of listed Games;
    3. the Leaderboard Fee;
    4. general Gemas;
    5. each Extend tranche, junior to everything issued before it.
  - Proportional within a class.
  - Moving Gemas carries their repaid part proportionally, and a Gema keeps its class and tranche for life.
  - Coverage counters `H`, `R`, `C` make `return_own` exact.
  - Ready Gemas are claims on the staking-token shares their yield was worth when it landed: holders carry a slash, as if they held the token (no Treasury cushion).
- **One basket per Account** replaces Holdings.
  - The program draws own Gemas first, then won Gemas by earliest planned repayment date.
  - Entries that need more lines than one transaction fits are staged in Entry Tickets, which have no line cap. A Player whose Gemas cover an entry can always enter.
  - Offers reserve an amount. Settle and refund run as one-way Settling/Refunding states in idempotent chunks.
  - Overflow records keep every credit durable.
- **Half the Yield Fee funds the Leaderboard Pool.** 20% stays the Yield Fee: 10% Tesoro's, 10% owed to the Pool once realised (`pool_owed`, in shares, protected from Treasury spending).
  - Each asset route has a prize escrow (Solana; inside each EVM vault). Prize Gemas are share claims on their own escrowed shares.
  - A Season's budget is frozen when recorded, and every rank gets the same mix.
- **Instant Redeem is an order Tesoro fills** (full or partial), cancellable by the Player, at a flat 25% fee.
- **Games.**
  - One PDA per Game, registered by proving control of the program; changes only by its authority after 7 days.
  - Listing ($500/yr, admin-approved) binds a deploy slot. An upgrade unlists the Game until re-approved, and a Match whose Game was upgraded after open can only refund.
  - Points, fee priority, Backing and sponsorship are for listed Games only.
  - The Studio Fee is capped at 10%, and no Match stays open past 7 days.
- **Shuffle.** The program picks the VRF input with a per-Match nonce and binds the callback to the request. Hold'em drops its Deck and Vanguard its Secret: secrets and VRF halves sit in each Player's own account, and the board is stored as two shares.

## Considered Options

- **Close accounts per Match only (no persistent tables)**: about $1.50 to $2.00 per Match, still a loss; MagicBlock's 0.003 SOL per delegated account dominates. Rejected.
- **Today's pro rata Redeem with fee counters**: "Redeem now" could fall when others Redeem or the owner Extends. Rejected for exact per-line bookkeeping.
- **No staged entries, fall back to the largest lines**: simpler, but it could reverse fast-first and couldn't guarantee entry. Rejected: the founder's rule is to build the best design, not the quickest.
- **Treasury bears slashing with a cushion**: rejected by the founder; holders carry the risk of the token they chose.
- **Automatic Instant Redeem within a budget**: deferred; the founder will decide with the cofounder. The order path leaves room for an automatic filler.
- **Bridge ETH/HYPE prize tokens to Solana, or swap them to SOL**: rejected for escrows inside each vault.
- **Holdings plus auto-close instead of a basket**: rejected; the program could not enforce the draw order.

## Consequences

- Supersedes, in ADR 0006, draining the Pool by ascending Source, and in ADR 0007, all of the Yield Fee going to the Treasury and Instant Redeem being automatic. ADR 0010 stands: yield is computed, and every touch syncs it.
- The treasury-in-shares fix (D1 realised-only, D2 holders carry slashes, D3 no cushion) lands with or before this. The Pool escrow ships switched off until it does.
- Block Puzzle keeps per-Match accounts until a separate decision. It adopts every ledger change.
- Devnet is wiped. App, keeper, bridge and EVM vaults change together.

Details: `.scratch/economy-upgrade/spec.md` until built, then `docs/tesoro-core.md`, `docs/cross-chain.md`.
