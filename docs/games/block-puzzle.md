# Block Burst (on-chain Game)

Live head-to-head puzzle Match on a Table. Program `block_puzzle` `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj`, settling through `tesoro_core` `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh`. Rules and engine: `programs/block_puzzle/src/engine.rs` with the bit-exact port `app/src/games/block-puzzle/engine.ts`. Client: `app/src/games/block-puzzle/live-chain.ts`. Keeper: `keeper/src/burst.ts`.

Both Players play the same Seed at the same time. The Player-facing rules (check-in, grace, hidden scores, draws, outage) live in one place, the Docs page `/docs/matches#block-puzzle`; this file is the on-chain design behind them. Spec: `.scratch/block-puzzle-live/spec.md`.

## Phases

All times are rollup slots (100 per second, `SLOTS_PER_SEC` in `state.rs`), read from the Table, never from `Date.now()`.

| Phase | Length | Ends when |
|---|---|---|
| Check-in | 60 s from `assigned_slot` | both Players called `check_in` |
| Seeding | 60 s, VRF retried every 20 s, at most 3 times | `seed_callback` stored the Seed |
| Get ready | 10 s | `start_slot` |
| Play | 90 s from `start_slot` | the freeze at 80 s hides scores; the last 3 s are the grace |
| Closing | after `start_slot` + 93 s, or when both Boards are over | `close`, then `commit_table`, `finalize` |

## Match flow

Base layer: `create_table`, `delegate_*`, `assign_match` (binds a joined Match to a free Table), `close_assignment`, `finalize` (settles by CPI into `tesoro_core`). Rollup: `init_seats` (once per Table), `begin_match`, `seat_players`, `check_in`, `request_seed` (permissionless), `seed_callback`, `start`, `begin`, `play` / `play_hidden`, `close`, `commit_table`, `wipe_seats`, `reset_table`, `release_slot`. Anyone can send every step after check-in; the Players' apps and the keeper all run the same step function, so the keeper is not a single point of failure.

Every Player instruction carries `Binding { tesoro_match, generation, epoch }`, so a stale transaction from an earlier Match on the same Table fails. `play` and `play_hidden` also carry `expected_count`, the Player's on-chain move count before the batch: a resent batch fails `WrongCount` and changes nothing.

## Seed

The Seed is drawn from the MagicBlock VRF inside the rollup and written only to the Table's private vault. `begin` copies it into the beginning Player's own Board (readable only by that Player). Nobody sees it before the Get ready countdown ends. Trust is the TEE operator and the VRF oracle (ADR 0003).

## Moves, freeze and grace

- `play` writes the public shown score and works until the freeze at `start_slot` + 80 s. From then only `play_hidden` works (read-only table, no public account). `play` after the freeze fails `Frozen`, `play_hidden` before it fails `NotFrozen`, so nobody can hide a score while watching the opponent's.
- Both end at `start_slot` + 93 s inclusive: the 90 s run plus a 3 s grace for the last transaction.
- Batches hold 1 to 8 moves. Pace: moves landed so far * 100 <= 4 * elapsed slots + 600, which allows 4 moves a second after a burst of 6.
- The score is the program's replay of the moves against the Seed; no instruction takes a score.
- Reconnect: read the own Board, rebuild the run from Seed and move log (`rebuildRun`), resume with `expected_count` = `board.moves`.
- The opponent strip shows `shownScore` and `shownMoves`; they stop updating at the freeze and the app shows "?".

## Outcome

| Case | Reason | Result |
|---|---|---|
| Higher replayed score | played | that Player wins |
| Equal scores, at least one Player made 5 or more moves | draw | refund |
| Equal scores, both under 5 moves | trivial | no-show: each side pays the Platform Fee |
| Both checked in, nobody moved | no-show | each side pays the Platform Fee |
| One paired Player did not check in | absent | the other Player wins (normal win, no new core result) |
| Neither checked in | neither | refund |
| Stall in the check-in window, rollup outage (`OUTAGE_RATIO` 0.5 / `STALL_SECS` 5) | void | refund |
| No Seed in time | noSeed | refund |

An unassigned Match is refunded by the core deadline, not by this program. A Match assigned but never begun is refunded by the core deadline too (24 h hold after assignment).

## Run logs

Both seats' move logs with slot offsets, and the Seed, live in `Table.logs` for the 8 ring slots (6,918 bytes, under the 10,240 CPI creation limit). `runLogOf(baseTable, match, epoch)` reads them for the result screen and for bot review (ADR 0012) until the ring slot is released.

## Tests

`cargo test -p block_puzzle` (needs `pnpm build:programs`): engine and TS parity vectors, the phase and outcome table above, freeze, grace, pace, binding and `WrongCount`. LiteSVM has no delegation, VRF or permissions; those, the visibility matrix after the freeze and the measured slot rate are checked on devnet at ticket 24.
