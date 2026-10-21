---
status: accepted
---

# Cheap Matches, fees paid first, one basket per Account, half the Yield Fee to the Pool

Decided (founder, Oct 20, 2026). Amended while building (Oct 21, 2026): the sections "The model" and "Changed while building" describe what the code does.

Measured on devnet, a Hold'em Match left about 0.026 SOL ($3.92) on chain while Tesoro earns $0.10 to $0.50 per Match. Fees reached Tesoro as Gemas that turn into SOL over up to 12 months. Gemas from different Sources looked equal but were not, and the program let the client pick which ones to bet. The Leaderboard Pool got only the 1% Leaderboard Fee. Game registration could overwrite an existing Game. This ADR changes all of that in one `tesoro_core` upgrade, before mainnet, while nobody plays.

## The model

- **Tables that stay on MagicBlock.** Each table Game (Hold'em, Trading Duel, Vanguard) keeps a capped set of tables, delegated once and never undelegated.
  - A Match is bound write-once to one table, generation and epoch.
  - Only the public table is committed; the result stays in a ring until a core settlement receipt proves it is no longer needed.
  - Hidden seat data lives in rollup-only accounts.
  - MatchState closes after settlement, and Match history moves to our database from core events.
  - Players never delegate.
  - Commits are paid by a delegated, core-sponsored fee account per Game (MagicBlock caps commits paid by an undelegated payer at 10 per session). Tables are never recycled.
- **Tesoro sponsors Players' SOL.** A server-built allow-list, a core-owned sponsor PDA (`["sponsor"]`) with a per-Account cap and a total cap, admission limits and a reserved exit budget.
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
  - **Every line owns its exact share of the staking token.** Ready Gemas are claims on the staking-token shares their yield was worth when it landed: holders carry a slash, as if they held the token (D2). There is no Treasury cushion (D3).
- **One basket per Account** replaces Holdings.
  - The program draws own Gemas first, then won Gemas by earliest planned repayment date.
  - Each Account also has a **spill**, a second sorted store with the same line layout. Credits that do not fit the basket go to the spill and are playable at once, without a claim. The draw, the free figure, withdrawals and Ticket staging span both.
  - Entries that need more lines than one transaction fits are staged in Entry Tickets, which have no line cap. A Player whose Gemas cover an entry can always enter.
  - Offers reserve an amount. Settle and refund run as one-way Settling/Refunding states in idempotent chunks.
- **Half the Yield Fee funds the Leaderboard Pool.** 20% stays the Yield Fee: 10% Tesoro's, 10% owed to the Pool once realised (`pool_owed`, in shares, protected from Treasury spending).
  - Each asset route has a prize escrow (Solana; inside each EVM vault). Prize Gemas are share claims on their own escrowed shares.
  - A Season's budget is frozen when recorded, and every rank gets the same mix.
- **Instant Redeem is an order Tesoro fills** (full or partial), cancellable by the Player, at a flat 25% fee (the Player gets 75% of the value at fill time).
- **Games.**
  - One PDA per Game, registered by proving control of the program; changes only by its authority after 7 days.
  - Listing ($500/yr, admin-approved) binds the build of the Game. An upgrade to different code unlists the Game until re-approved, and a Match whose Game was upgraded after open can only refund.
  - Points, fee priority, Backing and sponsorship are for listed Games only.
  - The Studio Fee is capped at 10%, and no Match starts settling later than 7 days after it opened.
- **Shuffle.** The program picks the VRF input with a per-Match nonce and binds the callback to the request. Hold'em drops its Deck and Vanguard its Secret: secrets and VRF halves sit in each Player's own account, and the board is stored as two shares.

## Changed while building

Each item replaced a line of the first draft of this ADR.

- **Exact shares per line, not pooled shares per class.** Ticket 03 pooled the shares of a class. Two red-teams showed it moved staking growth (about 1% to 3.5% a year) between holders, let an owner recycle Advances against old holders' pool, and spread a slash onto holders who were never exposed, against D2. Studio, general and Extension lines now own exact shares, with closed history kept in append-only checkpoint pages (never a ring). Platform and Leaderboard stay single-holder counters on the Source, which is exact for one holder. The cost is a 144-byte line (about 2.5 times the first estimate) and more compute per entry chunk.
- **The spill replaced overflow records.** The first draft kept overflow in claimable records. A claim needed a free basket slot, which could strand a Player. The spill removes the claim: it is created with the Account, grown with sponsored rent, shrunk by the owner, and `put` into it is atomic. Room is an explicit contract (`SpillFull` changes nothing; the instruction layer reserves room before it debits).
- **Backing Tickets have their own flag.** A Backing Ticket opened on a Backer can no longer block that Backer's own entries. One at a time, it blocks only new Offers; the Backer may cancel at once, and anyone may expire it.
- **Listing binds a code hash, not a slot.** The loader's plain `ExtendProgram` moves a program's deploy slot without changing its code, so a stranger could unlist a Game for the price of rent. `list_game(listed_until, approved_hash)` hashes the deployed bytes on chain (trailing zeros ignored); `refresh_listing` (anyone) moves the approved slot forward only when the bytes still match. A `listing_epoch` on the Game record, copied into each Match, bumps only when the admin approves different code, so a pending backed join survives a harmless extension and dies with a real upgrade. Settle and refund use `same_build`. Whether the loader's checked extend is active on the target cluster was not confirmed: the hash makes the answer irrelevant.
- **The Match deadline is absolute.** Open, join and extend all clamp to 7 days after open. Starting a settlement is refused at that point (only a refund can start); a settlement already running ignores the clock. The deploy slot is compared at the start of settling.
- **Prize escrow is an accounting bucket inside the custody vault,** not a separate token account. Only prize Redeem and the finish of a payout lower it. `spendable` excludes it, and the vault invariant counts it. A Season budget is frozen per Pool line, the 16 biggest free lines at most; the rest wait for a later Season. Leftovers roll over.
- **Instant Redeem sells only the part not yet repaid.** Repaid (ready) Gemas are Redeemed to the seller at full value at request and again at every fill, so the seller pays no fee on money Tesoro already owes. Orders are their own accounts; they live 1 hour to 30 days (7 days by default); the Player cancels any time; anyone returns an expired order. Orders do not reserve Tesoro's spendable shares while open; the check is at fill. An EVM fill is refused while the order holds repaid Gemas (the Player cancels and Redeems through the bridge).
- **The treasury slashing fix (D1, D2, D3) landed in the same build** (tickets 11 and 26). Tesoro spends only realised fees, holders of unlocked Locks are owed shares fixed at the Unlock rate, and both Solana and EVM Treasuries use one figure: `spendable = max(0, treasury shares - owed shares - pool_owed - reservations)`. A hole found on the way: the stake custody counted open Locks' fees as spendable; fixed with a red test first.
- **Registration also accepts immutable programs,** which sign through their own PDA `["tesoro-register"]`. The Studio recipient may not be the Pool, the Treasury or the platform recipient (checked at register, propose and apply). A joiner may join at most 20 Matches opened by the same opener per 24 hours.
- **Chunked settlement records its plan.** Fees are cut from the fewest loser lines, largest first; each cut is preceded by a sync of its Source. A no-show costs the Platform Fee once per side. A Draw is an exact refund.

## Still to build (recheck when each merges)

- **Matching (ticket 09).** `open_match`, `join_match` and their backed forms on baskets and Tickets, the settlement receipt PDA, event-CPI records, the per-Account Match counter and the cap on concurrent Matches, and the measured per-transaction line cap (12 is a placeholder). This ADR describes them from the spec.
- **Fee cash-in (ticket 11b).** Platform and Studio fee counters are repaid first by the payout order, but they only become the recipient's money through a permissionless cash-in per Source. Until it exists, Platform and Studio Fee Gemas stay in the counters.
- **Bridge and EVM vaults (tickets 16 and 17),** the table Games (12 to 15), the relayer, keeper, Supabase history and app (18 to 21), the Studio listing flow (23) and the devnet wipe and deploy (24).

## Considered Options

- **Close accounts per Match only (no persistent tables)**: about $1.50 to $2.00 per Match, still a loss; MagicBlock's 0.003 SOL per delegated account dominates. Rejected.
- **Today's pro rata Redeem with fee counters**: "Redeem now" could fall when others Redeem or the owner Extends. Rejected for exact per-line bookkeeping.
- **Pooled shares per class**: simpler, but it moves growth and slashes between holders. Rejected for exact shares per line.
- **No staged entries, fall back to the largest lines**: simpler, but it could reverse fast-first and couldn't guarantee entry. Rejected: the founder's rule is to build the best design, not the quickest.
- **Claimable overflow records**: a claim needed a free slot. Rejected for the spill.
- **Treasury bears slashing with a cushion**: rejected by the founder; holders carry the risk of the token they chose.
- **Automatic Instant Redeem within a budget**: deferred; the founder will decide with the cofounder. The order path leaves room for an automatic filler (`max_fill`, the fill authority, off by default).
- **Bridge ETH/HYPE prize tokens to Solana, or swap them to SOL**: rejected for escrows inside each vault.
- **Holdings plus auto-close instead of a basket**: rejected; the program could not enforce the draw order.
- **List by deploy slot alone**: a stranger's `ExtendProgram` unlists a Game. Rejected for the code hash.

## Consequences

- Supersedes, in ADR 0006, draining the Pool by ascending Source, and in ADR 0007, all of the Yield Fee going to the Treasury and Instant Redeem being automatic. ADR 0010 stands: yield is computed, and every touch syncs it.
- The Pool escrow ships switched off (`set_prize_escrow`) and is turned on by the admin once the vaults carry it.
- Block Puzzle keeps per-Match accounts until a separate decision. It adopts every ledger change.
- Devnet is wiped. App, keeper, bridge and EVM vaults change together. `Unlock` needs the `EconomyConfig` account, so `set_economy` runs in the same batch as the program upgrade.
- Open founder items: the loader's extend behaviour on mainnet is covered by the hash, not confirmed; the Instant Redeem budget and an automatic filler wait for the cofounder talk; Block Puzzle on tables needs its own decision.

Details: `docs/tesoro-core.md`, `docs/cross-chain.md`, `CONTEXT.md`. The spec (`.scratch/economy-upgrade/spec.md`) is the local build record.
