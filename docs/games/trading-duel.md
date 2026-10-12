# Trading Duel: Game program

Program `trading_duel` `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj` (Solana devnet, upgradeable). Two Players watch one live price for two and a half minutes on a price grid, in a MagicBlock Private Ephemeral Rollup (TEE). For each column of the grid a Player picks one box; the line passing through it scores 100 points. More points takes the Pot minus Fees through tesoro_core; equal points refunds both entries.

Code: `programs/trading_duel/src/{lib,state,engine}.rs`. Rules in TypeScript: `app/src/games/trading-duel/grid.ts`. Client: `app/src/games/trading-duel/chain.ts`. Registered in tesoro_core with studio_bps 300 and the `["authority"]` PDA `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe` (no tesoro_core change was needed, as for Hold'em).

## Rules

- Two Players, equal entry (500, 1,000 or 2,500 Gemas), paired through the Queue or a Challenge link. The Queue is per game, entry **and asset**.
- One asset per Match: SOL, ETH or HYPE.
- The grid has 12 columns of 10 seconds and 8 rows of price. The rows are fixed when the Match starts: row height is the start price (the anchor) times `STEP_PPM[asset]` (SOL 250, ETH 200, HYPE 270 parts per million), rows 1 to 6 sit around the anchor, row 0 is open below and row 7 open above, so the line always lands in some row.
- **Head start:** the line enters column 0 `HEAD_START_SECS` = 30 s after the Match starts. The Match ends `grid_at + 120 s` = 150 s after it starts.
- **Picks:** each Player picks one row per column with `set_pick(column, row)`, and can change or clear it (`row = NO_PICK`) for free until the column locks. It records no price sample.
- **Lock:** column `c` locks `LOCK_AHEAD_SECS` = 10 s before its window starts, which is when the column before it goes live. Picks for `c` are accepted while `now < lock(c)`.
- **Hidden until locked:** a pick lives in its Player's own Book. When a column locks, both picks for it are copied into the public `Duel.revealed`.
- **Hit:** a pick hits column `c` if the recorded prices of the column (its low and high, including the price where the line entered the column) overlap the pick's row. A hit scores `HIT_POINTS` = 100. A column without a pick scores nothing.
- **Result:** more points wins; equal points (including nobody picking) is a draw and both entries are refunded. A no-show (never started) refunds as well.

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

| Account | Seeds | Visibility during the Match |
|---|---|---|
| `Duel` | `["duel", match_id_le]` | public (a non-private permission): anchor, step, times, the price range of each column (`track`), `revealed` picks of locked columns, `scores`, `winner` |
| `Book` x2 | `["book", duel, seat]` | private to its Player: `picks[12]`, `pick_count` |

The tesoro_core Match id is `ms * 8 + asset * 2 + challenge`: bit 0 marks a Challenge (as for every Game), bits 1 and 2 are the asset (0 SOL, 1 ETH, 2 HYPE). `create_match` reads the asset from the id, so nobody can change it, and the Queue filters on it.

## Flow

| Step | Layer | Instruction | Who |
|---|---|---|---|
| open / join | base | tesoro_core `open_match`, `join_match` (game = this program id) | the two Players |
| bind | base | `create_match(match_id)` | either Player |
| delegate | base | `delegate_match` | anyone |
| permissions + start | TEE | `init_permissions` (reads the start price, sets the rows, starts the head start) | anyone |
| pick | TEE | `set_pick(column, row)` | the Player |
| sample and reveal | TEE | `tick` (about once a second during the grid: records the price, reveals locked columns, scores finished ones) | anyone |
| end | TEE | `end_match` | anyone, after the window |
| cancel | TEE | `claim_timeout` (delegated, never started, past `start_deadline`) | anyone |
| commit | TEE | `close_match` (closes permissions, commit + undelegate), or `close_unstarted` for a cancelled Duel (it never had permissions) | anyone |
| settle | base | `finalize` (CPI `settle_match`, or `refund_match` for a draw or cancel) | anyone |

Picks are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in Hold'em; there is no separate session key. Both Players' apps and the keeper call `tick`.

## Known gaps

- `set_pick` does not record a price sample or reveal columns; the next `tick` (or `end_match`) does, so a locked pick stays unrevealed until then.
- A column's range only holds the prices that were sampled. Between two samples the price is not observed, so a brief move that happened and reversed between two ticks is not a hit. Clients tick about once a second.
- Programs are devnet only; the feeds are devnet rollup copies.

## Verification

`cargo test -p trading_duel`: engine unit tests against the shared fixture plus LiteSVM tests against the real `trading_duel.so` and `tesoro_core.so` (picks before and after the lock, reveal on lock, sampling, `end_match` then `finalize` paying the winner or refunding a draw, a non-player refused). LiteSVM has no delegation or permission programs, so `init_permissions` and `close_match` are stood in for by writing the state they produce. `app/src/games/trading-duel/grid.test.ts` runs the same fixture.

The grid version of the program has not been deployed to devnet yet; the earlier leveraged version's devnet evidence was removed with it.
