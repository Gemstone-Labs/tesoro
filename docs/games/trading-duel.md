# Trading Duel: Game program

Program `trading_duel` `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj` (Solana devnet, upgradeable). Two Players watch one live price for two and a half minutes on a price grid, in a MagicBlock Private Ephemeral Rollup (TEE). For each column of the grid a Player picks one box; the line passing through it scores 100 points. More points takes the Pot minus Fees through tesoro_core; equal points refunds both entries.

Code: `programs/trading_duel/src/{lib,state,engine}.rs`, table protocol pieces in `crates/table_kit`. Rules in TypeScript: `app/src/games/trading-duel/grid.ts`. Client: `app/src/games/trading-duel/chain.ts`. Registered in tesoro_core with studio_bps 300 and the `["authority"]` PDA `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe` (no tesoro_core change was needed, as for Hold'em).

## Rules

- Two Players, equal entry (100, 500 or 1,000 Gemas), paired through the Queue or a Challenge link. The Queue is per game, entry **and asset**.
- One asset per Match: SOL, ETH or HYPE.
- The grid has 12 columns of 10 seconds and unbounded bands of price. The bands are fixed when the Match starts: band height (`step`) is the start price (the anchor) times `STEP_PPM[asset]` (SOL 120, ETH 100, HYPE 130 parts per million; about $0.0135 a band for SOL at $112). Band `k`, a signed integer, is `[anchor + k*step, anchor + (k+1)*step)`: band 0 starts at the anchor, negative bands lie below it. `band_of(price) = floor((price - anchor) / step)`, clamped to -32767..32767 (picks are `i16` and `NO_PICK` = -32768 is the sentinel). No band is open-ended, so a day's move never leaves the grid: the app scrolls the view to follow the line and the Player picks any band, near or far.
- **Head start:** the line enters column 0 `HEAD_START_SECS` = 30 s after the Match starts. The Match ends `grid_at + 120 s` = 150 s after it starts.
- **Picks:** each Player picks one band per column with `set_pick(column, band)` (any `i16`), and can change or clear it (`band = NO_PICK`) for free until the column locks. It records no price sample.
- **Lock:** column `c` locks `LOCK_AHEAD_SECS` = 10 s before its window starts, which is when the column before it goes live. Picks for `c` are accepted while `now < lock(c)`.
- **Hidden until locked:** a pick lives in its Player's own Book. When a column locks, both picks for it are copied into the public `Table.revealed`.
- **Hit:** a pick hits column `c` if the recorded prices of the column (its low and high, including the price where the line entered the column) include the pick's band: `band_of(low) <= band <= band_of(high)`. A hit scores `HIT_POINTS` = 100. A column without a pick scores nothing.
- **Result:** more points wins; equal points is a draw and both entries are refunded. If both Players checked in and neither picked at all, the Match is a no-show: each side pays the Platform Fee and gets the rest of its entry back. If only one Player checked in before the start deadline, that Player wins a normal Match (the pot less the normal Fees); if neither did, it is a no-show with the Platform Fee each. A Match the table never began refunds exactly.

The exact column range rules (carry-over of the entry price, columns with no sample, the closing sample) are written in `engine.rs` (`Track::record`, `finish`, `hits`) and mirrored in `grid.ts`. Both are tested against one shared fixture, `programs/trading_duel/tests/fixtures/grid-vectors.json`, so they cannot drift.

### Why lock-ahead and not a lag on the price

The original idea for this game showed the Players a price delayed by 30 seconds, so nobody could see a pick's outcome before it locked. A delayed display can be front-run: anyone reading the real feed elsewhere sees the line 30 seconds before the lagging Player does. Here the line is never delayed. Instead a column locks 10 seconds before its window starts, so every pick is made at least 10 to 20 seconds before the line gets there, and a faster feed gives nothing: the price 10 seconds ahead cannot be read from any feed. Picks are private until they lock, so the opponent cannot copy a pick and still change their own.

### Prices

Every sample is a real oracle price: a price older than `MAX_STALE_SECS` = 2 s, more than `MAX_FUTURE_SECS` = 10 s ahead of the rollup clock, with a confidence interval wider than 1% of the price, a wrong owner or address or an exponent other than 8 is refused. So extra `tick` calls can add detail to the line but cannot fake a hit.

### The end

`end_match` is permissionless and valid once the window closed. It reads no price: columns the line did not reach take the last price recorded (`Track.last`), every column is revealed and scored and the winner decided. No end price is added to column 11, so the result is the same whoever ends the Match and whenever, early or late. The clients try right at the end (the second Player a couple of seconds later) and retry every second; the keeper steps in after 2 s.

## Oracle

MagicBlock real-time pricing oracle (Pyth Lazer pushed into rollup accounts every 50 to 200 ms), program `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`. The same accounts exist on the devnet rollup and on the TEE (verified 2026-10-03):

| Asset | Feed account |
|---|---|
| SOL/USD | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| ETH/USD | `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG` |
| HYPE/USD | `CxEkVoCUwSAprvAhdWRPH63JeioQVNDtyZYEMRXuLu6x` |

Layout (a Pyth `PriceUpdateV2` image, 134 bytes): feed id at 41 (equals the account key), price i64 at 73, confidence u64 at 81, exponent i32 at 89 (the pusher writes `8`, meaning 1e-8), publish time i64 at 93 (seconds). The program reads the bytes itself, with no Pyth dependency.

## Accounts and ids

Matches run on persistent tables that stay delegated to MagicBlock's TEE (design: `table-protocol.md` in the economy-upgrade notes; shared code: `crates/table_kit`). Nothing is created or delegated per Match.

| Account | Seeds | Where | Visibility |
|---|---|---|---|
| `TableConfig` | `["config"]` | base | the operator, the current table generation, the table cap (set by the upgrade authority) |
| `Sponsor` | `["sponsor"]` | delegated once | pays commits as the fee payer |
| `Fuel` | `["fuel", n]` | delegated | reserves the operator empties into the Sponsor in the rollup |
| `Table` | `["table", generation u16 LE, index u16 LE]` | delegated once, never undelegated | public: epoch, phase, the Match on it, anchor, step, times, the price range of each column (`track`), `revealed` picks of locked columns, `scores`, `winner`, and the result ring |
| `Assignment` | `["assign", tesoro_match]` | base | binds one tesoro_core Match to one table and epoch, once; Players and asset are copied from the Match |
| `Book` x2 | `["book", table, seat]` | ephemeral, in the rollup | private to its Player (`picks[12]`, `pick_count`); created when the seats open, closed when the Match is over |

The asset is carried in the tesoro_core Match (`meta.asset`), so nobody can change it, and the Queue filters on it.

The **result ring** keeps the outcome of the last 8 finished Matches (Win0, Win1, Draw, NoShow) in the table until tesoro_core has frozen the Match; only then is the slot freed (`release_slot`, on core's settlement receipt). `finalize` reads only the ring, so resetting the table can never lose a result.

## Flow

| Step | Layer | Instruction | Who |
|---|---|---|---|
| open / join | base | tesoro_core `open_match`, `join_match` (game = this program id) | the two Players |
| assign | base | `assign_match(generation, index, epoch)`: copies Players and asset, fixes the start deadline, holds core's refund timer 24 h | the operator |
| begin | TEE | `begin_match`: only at the assigned table and epoch, only while the core Match is Active; reserves a ring slot | anyone |
| seats | TEE | `open_seats`: creates both Books behind private permissions | anyone |
| check in | TEE | `check_in`; the second Player starts the Match (anchor price read, head start begins) | the Players |
| pick | TEE | `set_pick(column, band)` | the Player |
| sample and reveal | TEE | `tick` (about four times a second during the grid) | anyone |
| end | TEE | `end_match`: writes the result into the ring slot; both Players picked nothing = no-show | anyone, after the window |
| no check-in | TEE | `expire_start`: past the start deadline, the Player who checked in wins; nobody checked in is a no-show (`table_kit::absence_outcome`) | anyone |
| commit | TEE | `commit_table`: once per result, paid by the Sponsor | anyone |
| close seats, reset | TEE | `close_seats`, then `reset_table` (committed, seats closed, 30 s after the end): wipes the Match, epoch + 1, ring kept | anyone |
| settle | base | `finalize`: reads the committed table, then CPI `settle_match`, `refund_match` (draw) or `NoShow` | anyone |
| free slot | TEE | `release_slot` (core's receipt, 60 s old), `void_table` (core already refunded a Match the table never finished) | anyone |
| close assignment | base | `close_assignment` (after the receipt) | anyone |

Without a result, `finalize` refunds only when the committed table has moved past the Assignment's epoch without the Match; otherwise a stuck Match refunds at tesoro_core's own deadline.

Picks are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in Hold'em; there is no separate session key. Both Players' apps and the keeper call `tick`.

## Known gaps

- `set_pick` does not record a price sample or reveal columns; the next `tick` (or `end_match`) does, so a locked pick stays unrevealed until then.
- A column's range only holds the prices that were sampled. Between two samples the price is not observed, so a brief move that happened and reversed between two ticks is not a hit. Clients tick about four times a second (a call is never sent while the last is in flight, and failures back off), which matches the feed, whose reading changes several times a second.
- Programs are devnet only; the feeds are devnet rollup copies.

## Verification

`cargo test -p trading_duel` (engine unit tests against the shared fixture plus 48 LiteSVM tests against the real `trading_duel.so` and `tesoro_core.so`: a table reused for several Matches with every result settled from the ring after resets, wrong table, owner and epoch refused, a stale commit never refunding a win, slot release only on core's receipt, void and reset rules, one commit per result) and `cargo test -p table_kit`. LiteSVM has no delegation, ephemeral-account, permission or commit programs: `open_seats`, `close_seats`, the commit and delegation are stood in for by writing the state they produce. `app/src/games/trading-duel/grid.test.ts` runs the same fixture.

Devnet evidence for the tables (real delegation, commits through the Sponsor, ephemeral Books, the delegated-table read in `finalize`) is part of the economy-upgrade deploy ticket; the program has not been deployed.

## Result history

A table is reused, so the final board of a finished Match would be overwritten by the next Match's commit. The keeper copies each finished Match's public end state (the 24 picks, the line range, the scores) into the Match history right before it resets the table, and the reset waits for that copy. The result screen reads the table while it still holds the Match, then the history (`/api/end-state/<match>`), and says the board is no longer available if neither has it. Hold'em (board, shown hands) and Block Burst (final scores, move log) are kept the same way.
