# Trading Duel: Game program

Program `trading_duel` `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj` (Solana devnet, upgradeable). Two Players trade one live price for five minutes, from the same Chips stack, in a MagicBlock Private Ephemeral Rollup (TEE). The higher final equity takes the Pot minus Fees through tesoro_core; equal equity refunds both entries. Chips never leave the Match.

Code: `programs/trading_duel/src/{lib,state,engine}.rs`. Client: `app/src/games/trading-duel/chain.ts`. Registered in tesoro_core with studio_bps 300 and the `["authority"]` PDA `mPXSGjpEeSeJnmrBw3CKCoLbbftAsjsbiP1eE3wHcoe` (no tesoro_core change was needed, as for Hold'em). Deploy tx `616jDmGR...V3Xmgp`.

## Rules

- Two Players, equal entry (500, 1,000 or 2,500 Gemas), paired through the Queue or a Challenge link. The Queue is per game, entry **and asset**.
- One asset per Match: SOL, ETH or HYPE.
- Each Player starts with 10,000 Chips. One position at a time: long or short, margin of at least 100 Chips, leverage 1x to 20x, closed or flipped (close then open) at will, unlimited trades.
- The window is 5 minutes, opening 5 seconds after the Match starts in the rollup.
- Fills execute at the on-chain oracle price. Equity = free Chips + margin + PnL of the open position (as if closed now).
- End: positions are marked at the final oracle price; the higher equity wins, equal equity (including neither Player trading) is a draw and both entries are refunded. A no-show (never started) refunds as well.
- Hidden: each Player's Book (position and fills) is readable only by that Player while the Match runs. The public Duel carries only a coarse lead (level, or which seat is ahead by at least 50 Chips) and the trade counts. After the Match is committed both Books are public: both full fill histories show on the Match page.

### Anti-latency rule

A client can see public prices a moment before the rollup feed updates. Chosen: **a spread of 5 bps on every fill** (buys pay the price up, sells receive it down, entry and exit alike) **plus rejection of any oracle price older than 2 seconds** (and more than 10 seconds ahead of the rollup clock). Fills at the next oracle update would need a pending-order account and a crank; the spread is deterministic, atomic and testable, and one second of price movement rarely exceeds 5 bps. The feed timestamp has one-second resolution, hence integer ages: measured on the TEE over 60 s the feed was 0.4 to 1.8 s old (median 1.0, p95 1.5) for SOL, ETH and HYPE, so 2 s rarely refuses a trade in normal conditions (a refused trade costs nothing, the client retries) and shortens the window in which someone watching a faster feed trades on a stale price, which at 20x matters more than at 5 s. Also rejected: a confidence interval wider than 1% of the price, a wrong owner or address, an exponent other than 8.

### Liquidation

Maintenance margin is 50 bps of the position's notional. On every price read (`open_position`, `close_position`, `tick`, `end_match`, for both Books) a position whose margin plus PnL, valued at the closing price, is at or below maintenance is liquidated **at that price**: the Player gets back `max(0, margin + PnL)` and the loss is capped at the margin. Between reads the price is not observed: a position that dipped and recovered between two reads is not liquidated. Anyone may call `tick`; the clients and the keeper do.

### Final marking (known gap)

`end_match` is permissionless and valid once the window closed. **Pinned price:** called within `END_GRACE_SECS` (4 s) after the end it needs a fresh oracle price published inside `[ends_at, ends_at + 4 s]` (a price from before the end, or from after the grace, is refused); called later it ignores the feed and settles at the last mid recorded during the window (`Duel.final_price` holds the last mid of every trade or tick, then the final price), so waiting for a better move cannot change the result and a late keeper is deterministic. Open positions are closed with a final fill (spread included). Inside the grace the first caller still picks among about four one-second ticks; the clients call right at the end (seat 1 immediately, seat 0 after 6 s, retrying every second) and the keeper after 6 s. The last mid is as old as the last trade or tick (clients tick every 4 s).

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
| `Duel` | `["duel", match_id_le]` | public (a non-private permission) |
| `Book` x2 | `["book", duel, seat]` | private to its Player |

The tesoro_core Match id is `ms * 8 + asset * 2 + challenge`: bit 0 marks a Challenge (as for every Game), bits 1 and 2 are the asset (0 SOL, 1 ETH, 2 HYPE). `create_match` reads the asset from the id, so nobody can change it, and the Queue filters on it.

## Flow

| Step | Layer | Instruction | Who |
|---|---|---|---|
| open / join | base | tesoro_core `open_match`, `join_match` (game = this program id) | the two Players |
| bind | base | `create_match(match_id)` | either Player |
| delegate | base | `delegate_match` | anyone |
| permissions + start | TEE | `init_permissions` | anyone |
| trade | TEE | `open_position(side, margin, leverage)`, `close_position` | the Player |
| mark | TEE | `tick` | anyone |
| end | TEE | `end_match` | anyone, after the window |
| cancel | TEE | `claim_timeout` (delegated, never started, past `start_deadline`) | anyone |
| commit | TEE | `close_match` (closes permissions, commit + undelegate; Books are not wiped), or `close_unstarted` for a cancelled Duel (it never had permissions) | anyone |
| settle | base | `finalize` (CPI `settle_match`, or `refund_match` for a draw or cancel) | anyone |

Trades are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in Hold'em; there is no separate session key.

## Known gaps

- Inside the 4 s end grace the first caller of `end_match` picks among a few ticks; later calls use the last recorded mid (above).
- Liquidation is at the next price read, not at the trigger price.
- The fill log keeps the last 64 fills per Player; the trade count is exact.
- The Lead is public and reveals who is ahead by 50 Chips or more, by design.
- A backed Player can only choose the asset where the Queue link carries it (default SOL).
- Programs are devnet only; the feeds are devnet rollup copies.

## Devnet evidence (Solana devnet + MagicBlock devnet TEE, 2026-10-03)

Program `trading_duel` `CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj`. Players are test wallets funded with simulated Gemas (a stand-in Position and Advance each). TEE transactions are private (no public explorer page). Signatures are shortened here (the pre-commit hook refuses full ones); the full set per run is written by `programs/trading_duel/scripts/play.ts` to `evidence-<mode>.json` (git-ignored).

**Scripted, every on-chain step** (`play.ts`, through the same client the app uses; each run checks: both entries in escrow, Duel starts with a 300 s window, the Duel is readable by an outsider, a Player reads null for the opponent's Book and their own Book normally, positions open with the spread, the public Duel shows only the lead and trade counts, the Match ends, `finalize` settles by CPI, the winner's Gemas move, both Books become public with every fill):

| Run | Asset | Match id | Outcome | Notable steps |
|---|---|---|---|---|
| full | SOL | `14327732236408` | seat 1 won, equity 10,021 to 9,911 | `create_match` `3qH6vvBr...`, `end_match` `5GmZtxgj...`, `finalize` `5XF6JLJQ...` |
| full | HYPE | `14327742202396` | seat 0 won, 9,993 to 9,971; winner 74,000 to 74,450 Gemas (entry 500, fee 50) | `delegate_match` `eJmJ6jW9...`, `end_match` `31v97Z6H...`, `finalize` `4bQvNXWs...` |
| draw | ETH | `14327736067186` | nobody traded, 10,000 each, `refund_match`, both entries back | `finalize` `46iXXPDj...` |
| no-show | SOL | `14327749974168` | created and delegated, never started: `claim_timeout` after the start deadline, `close_unstarted`, `finalize` refunds both entries | `claim_timeout` `3ktUCjz7...`, `finalize` `3q1th5ia...` |

**In the browser** (`app/scripts/qa-trading-duel.mjs`, two dev wallets, Player A on a 1440 desktop and Player B on a 390 phone, Queue entry, then everything driven by the clients: create, delegate, start, trades, `tick`, `end_match`, `close_match`, `finalize`):

- ETH Queue Match `14327757396330`: A long 5x, B short 5x, A closed. Final equity 9,986 (A) to 9,995 (B); A lost 500 Gemas, B won; both fill histories shown on the result.
- SOL Queue Match `14327753137600`: both traded; the clients were closed before the end, so the Match was ended, committed and settled by a script standing in for the keeper (`end_match`, `close_match`, `finalize`), seat 1 won 9,996 to 9,990.
- HYPE draw `14327762412308`: nobody traded, "Refunded, equal equity: a draw, both entries refunded", entries back.
- **Backed** (`app/scripts/qa-trading-duel-backed.mjs`, three wallets): a Player with no Gemas posted a Request for Trading Duel, a Backer answered with an Offer (40% share), the Player accepted and entered the Queue under the Backing, an opponent joined, SOL Match `14327772171784`. The backed Player won 9,996 to 9,993; split on the result: Backer's entry 1,000 back first, fees 100 from the loser, surplus 900 as 360 to the Player and 540 to the Backer; "You never owe anything". A third wallet viewing the Match sees it as a spectator with both fill histories.

Screens in `app/docs/screens/trading-duel-live-*.png` (position, closed, result for both Players, backed Request, Offer, accepted Backing, result and spectator view) and `trading-duel-practice-*.png`.

**What this showed about the rollup**

- The feed accounts update about once a second on both the devnet rollup and the TEE, and a program in the TEE reads them natively; the ER clock matched the oracle's publish time (a `5 s` staleness bound never fired; later tightened to 2 s, see above).
- The public Duel can be read without a token (its permission is not private); a Book reads as null for anyone but its Player. A Player's token read of the opponent's Book also returns null.
- `close_match` on a Duel that never started failed ("illegally used as writable": its permission accounts do not exist), so a cancelled Duel is committed by `close_unstarted` instead. The program was upgraded in place for it (slot 506736837).
- `close_match` uses about 150,000 CU (the default limit is 200,000); the client sends 400,000. `GetCommitmentSignature` can race the commit, so the client does not depend on it.

## Verification

`cargo test -p trading_duel`: engine unit tests plus LiteSVM tests against the real `trading_duel.so` and `tesoro_core.so`. LiteSVM has no delegation or permission programs, so `init_permissions` and `close_match` are stood in for by writing the state they produce.
