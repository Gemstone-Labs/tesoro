# A weekly Leaderboard paid from a 1% Leaderboard Fee, ranked off-chain from on-chain events

> Superseded in part by ADR 0013: the Pool is also funded by half the Yield Fee, every rank is paid the same mix of coins from a frozen Season budget (not by draining Holdings in Source order), the Pool holds a basket (Holdings are gone), the ranking reads only events the core program wrote, and the Leaderboard Fee is repaid third in the payout order. Points, Seasons and the prize shares stand.

Decided (founder, Oct 10, 2026). Every Match in every game pays a **Leaderboard Fee** of 1% of the Pot (`Config.leaderboard_bps`, 100) into the **Leaderboard Pool**, on top of the Platform Fee and the Studio Fee. Each won Match earns its Player **points** (entry / 100: 5, 10, 25). Each **Season** (one week, Monday 00:00 UTC, Season 1 from 2026-10-05) ends by paying the pool to the top ten on a sliding scale, 25 / 18 / 13 / 10 / 8 / 7 / 6 / 5 / 4 / 4%.

## How it is built

- **Fee.** `Match::settle_with(outcome, LeaderboardTerms)` takes the fee from the loser's lines after the Platform and Studio Fees, so it follows the same rules (Source-preserving, floored, nothing on a draw or refund). The rate and the pool live in `Config` and are read **when the Match settles**, not snapshotted: `FeeTerms` is stored inside every `MatchState`, and growing it would break the decoding of every Match already on chain. With `leaderboard_bps = 0`, or before `init_leaderboard`, nothing is charged. Platform + Studio + Leaderboard stay under `MAX_TOTAL_FEE_BPS` (50%), checked when any of them is set and again at settlement.
- **Pool.** A `TesoroAccount` whose authority is the PDA `["leaderboard"]`. Nobody can sign for that address, so only `pay_season_rank` moves its Gemas. Holdings of it are opened by anyone with `open_holding`, as for every other Account.
- **Points are events, not state.** `settle_match` emits `MatchWon { match_id, game, entry, player, funder, points, pool_fee, season, ts }` for every decisive Match. Writing per-Player scores on chain from `settle_match` would need a score account in every Game program's settlement CPI (three programs, deployed, two days before the deadline). Instead the standings are the sum of `MatchWon` events: every win also pays the pool Account, so its transaction history is exactly the list of wins, and anyone can recompute a season (`app/src/lib/chain/leaderboard.ts`).
- **Who earns the points.** The Player who played (`side.player`), including a backed Player. The Backer funded the entry and takes their share of the Gemas; points reward playing. A Backer cannot farm points by backing.
- **Ranking and ties.** Points descending, then the earlier first win in the season, then the Account key (so the order is total). Fewer than ten ranked Players: only their shares are paid, the rest stays in the pool and rolls into the next season.
- **Payout in two instructions.** After the season ends, `record_season(number, points[])` (admin or the keeper, i.e. `Config.oracle_authority`) creates the `Season` PDA `["season", number]` with the ranking (Accounts passed as remaining accounts and checked to be genuine Tesoro Accounts) and fixes each prize as a floored share of the pool balance at that moment. The PDA's existence makes it once-only. Then `pay_season_rank(rank)` pays one rank: a bit in `paid_mask` makes it once-only per rank, and the Gemas move from the pool's Holdings to the winner's Holdings **of the same Sources**, draining the pool Holdings in ascending Source order (the same canonical order as an entry draw). One rank per transaction because the pool may hold Gemas of many Sources, and each Source needs two accounts.
- **Migration.** `Config` gained two fields (`leaderboard_bps`, `pool_account`) **after** `games`. The account was created with room for the maximum number of Games, so its unused tail is zero and an old Config decodes with both fields zero. `init_leaderboard(bps)` (admin) extends it with `realloc`, creates the pool Account and sets the fee; calling it again only changes the fee.

## Trust

The ranking is the one input the program cannot check: it cannot see Matches from `settle_match`. The program enforces everything else (the season has ended, the ranking is ordered and distinct, the accounts are real, prizes are exact floored shares of the pool, each rank is paid once, Sources are preserved), and the keeper's ranking is public and recomputable from the events, so a wrong one is detectable and, being recorded in the `Season` PDA before anything is paid, visible before the first prize moves. Moving the ranking itself on chain (a score per Account written by `settle_match`) is the clean fix and is listed under Consequences.

## Considered Options

- **Scores written by `settle_match`.** Fully trustless, but changes the CPI accounts of every Game program, and a settlement is already near the transaction size limit (docs/tesoro-core.md). Rejected for now.
- **Fee snapshotted in the Match, like the Platform and Studio Fees.** Consistent, but changes the layout of every Match account, including the settled ones the app reads for history. Rejected.
- **One `pay_season` instruction for all ten ranks.** The pool holds Gemas of many Sources and each prize needs two accounts per Source, so it does not fit in a transaction. Rejected for the per-rank instruction.
- **Prizes in a single Source (the pool swaps).** Gemas of different Sources are not equal at redemption (ADR 0001); a swap would change someone's claim. Rejected: prizes keep their Sources.

## Consequences

- A Match opened before the upgrade and settled after it pays the Leaderboard Fee; display of Matches settled before it shows 1% more fee than was taken. Devnet only.
- Self-play farming: two Accounts of one person can trade wins. Each win costs 6% of the Pot in fees, of which only the 1% Leaderboard Fee returns to a pool the farmer shares with everybody else, so farming points is a net loss unless the pool is mostly the farmer's own fees. Not prevented; entries are Gemas the farmer would otherwise play.
- The keeper must run through the season boundary; `record_season` is open to the admin as a fallback.
- Seasons are fixed constants (`ledger/season.rs`, `lib/chain/season.ts`): changing the length needs a program change.
