# 0015: Add a second Match path for many seats instead of rewriting the head-to-head path

Status: accepted for implementation (Railcar spec, Core section). Ticket 01 prepares it by moving the settle building blocks into shared code with no behaviour change.

## Context

Tesoro's core is built for exactly two Players at every layer. The Match record holds two sides, the Pot is two entries, `MatchResult` names Opener, Joiner, Draw or NoShow, the settle has a fixed plan (cut fees from the loser, return the winner's entry, hand over the surplus), Backing and Points assume one winner and one loser, and the pair limit is keyed on two Accounts.

Railcar needs a Match of 5 to 100 Players where many seats get something back (an early Jumper's refund, the last three off a share of the forfeited Gemas) and nobody wins "against" one opponent.

Four Games are live on the head-to-head path, `tesoro_core` is audited as it stands, and the W3 launch-rules upgrade followed by the core freeze and internal audit is weeks away (mainnet go/no-go Dec 1, Dec 15 latest). Whatever changes in core must be easy to review and must not move a single Gema in an existing Match.

## Decision

Keep the head-to-head path (two sides, the three-step settle, `MatchResult`) as it is, and add a second path in core for 2 to 100 seats with its own record, paged seats, boarding instructions and a game-agnostic result (per seat: a refund and a place share).

Both paths share the code that moves Gemas: fee totals and the surplus after fees, the fee cut from a Pot line, the hand-out of a Pot line to a payee (an entry back, plain won Gemas, the Player and funder split of a Backed winner). These live in `ledger/lifecycle/blocks.rs` and are called by the head-to-head settle today and by the many-seat settle later. Moving them is a prefactor with no behaviour change: the existing core and Game test suites pass unchanged.

The many-seat path does not use the pair limit or the head-to-head NoShow rule. Head-to-head expressed in the many-seat result shape (winner place 100%, loser nothing) gives today's numbers, and a test checks this. It is a check, not a migration.

## Considered options

- **Rewrite head-to-head as an N-seat Match.** One path to audit in the long run, and no duplicated plan. Rejected: it changes the settle of four live Games just before the freeze, every fixed-size assumption (record size, chunk budget, receipt, events, keeper reads) moves at once, and a rounding or ordering difference would move real Gemas in existing Matches. The audit would re-cover code that is already covered.
- **A separate program for many-seat Matches.** Keeps core untouched. Rejected: Pot pages, Entry Tickets, Backing, Protections, the Entry Limit, Listing, Season Points and the Leaderboard all live in core accounts and would be reached by CPI across programs, with the fee and line rules copied or duplicated. Two programs would drift on the Payout order.
- **A second path inside core, sharing the building blocks (chosen).** Existing Matches stay on audited code; new code is the new path plus a pure move of shared helpers; both paths share fee and line code so the Payout order has one definition.

## Consequences

- Two settle plans exist in core until a later decision folds head-to-head into the many-seat shape. Any change to the fee or line rules goes into the shared blocks and so touches both paths; their tests must run together.
- The head-to-head record, receipt, events and keeper reads do not change, so no migration of existing Matches and no app or keeper change for the four live Games.
- The many-seat path adds its own record and instructions to the frozen core and its own account sizes to the audit scope.
- The fold-in of head-to-head into the many-seat shape stays open. It is cheaper to decide after the freeze with the many-seat path in production than before it.
