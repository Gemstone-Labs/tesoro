# The Invite gate is a co-signing key, and the Points cap is enforced off chain within a 48-hour payout window

Proposed (founder, Oct 15, 2026). At mainnet launch only waitlist members may play (one Invite each), and Leaderboard Points must resist two Accounts farming each other. Games are on-chain programs, so any rule kept in the website alone is skipped by a bot calling the programs directly.

## Decisions

- **Invite gate:** while the gate is on, `create_account` requires a second signature from an Invite key. The server signs only after checking an unused Invite code in its private store and marking it used. One admin switch turns the gate off at public launch. The Invite's email becomes the Account's notification email, stored off chain, never on chain.
- **Points cap:** only a Player's first 3 wins against the same opponent in a Season earn Points. The win event (`MatchWon`) also names the loser; the keeper applies the cap when it builds the Season, as it already builds Points from events today.
- **Payout window:** `record_season` opens a 48-hour window before any `pay_season_rank` may run. In that window the admin may void a Player; their share rolls into the next Season. Anyone can rebuild the Season from public events and check the keeper's numbers.

## Considered Options

- **Invite code hashes stored on chain, the Player submits the code:** rejected. It publishes the code list for no gain, and the server must still tie the code to an email.
- **Gate in the app only:** rejected. Bots skip it.
- **Per-pair win counters on chain:** rejected. Storage for every pair of Players, and the program would still trust the oracle's Season record.
- **Manual approval before any payout:** rejected. A Season stalls when nobody approves; voiding inside a window fails safe.

## Consequences

- The oracle remains trusted for Points, as it is today; the 48-hour window and public events are the check.
- These rules ship in the same `tesoro_core` upgrade as the Protections (Entry Limit, Break, Self-Exclusion), Block Puzzle move timing and mainnet entry sizes, before the programs are frozen for audit.

## Implementation notes (payout window)

- `record_season` also creates a `SeasonWindowState` PDA (`["season_window", number]`) with the record time and a voided-rank mask. It is a separate account so the `SeasonState` layout is untouched and Seasons recorded before the upgrade stay decodable; those have no window account and `pay_season_rank` (which now takes it) cannot pay them.
- `pay_season_rank` is refused with `PayoutWindowOpen` until `PAYOUT_WINDOW_SECS` (48 h) after the record, and with `RankVoided` for a voided rank.
- `void_season_rank(rank)` is admin only (the keeper's oracle key cannot), valid only inside the window and before the rank is paid. The slot pays nothing and the other ranks keep their places and amounts; the voided share stays in the Pool for the next Season, like an unfilled rank.
- The keeper records at Season end, then pays only unpaid, unvoided ranks once the on-chain record time plus 48 h has passed; it keeps no state, so a restart changes nothing. The Leaderboard shows "paying out <date>" during the window and "not paid" for voided ranks.
