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

A client can see public prices a moment before the rollup feed updates. Chosen: **a spread of 5 bps on every fill** (buys pay the price up, sells receive it down, entry and exit alike) **plus rejection of any oracle price older than 5 seconds** (and more than 10 seconds ahead of the rollup clock). Fills at the next oracle update would need a pending-order account and a crank; the spread is deterministic, atomic and testable, and one second of price movement rarely exceeds 5 bps. The feed timestamp has one-second resolution, hence the 5 s limit. Also rejected: a confidence interval wider than 1% of the price, a wrong owner or address, an exponent other than 8.

### Liquidation

Maintenance margin is 50 bps of the position's notional. On every price read (`open_position`, `close_position`, `tick`, `end_match`, for both Books) a position whose margin plus PnL, valued at the closing price, is at or below maintenance is liquidated **at that price**: the Player gets back `max(0, margin + PnL)` and the loss is capped at the margin. Between reads the price is not observed: a position that dipped and recovered between two reads is not liquidated. Anyone may call `tick`; the clients and the keeper do.

### Final marking (known gap)

`end_match` is permissionless, valid once the window closed, and uses the first oracle price published at or after the end time (so a price from before the end is refused). Open positions are closed with a final fill (spread included). Whoever calls first fixes the tick: with one-second feed resolution the choice is small, and both clients and the keeper call as soon as the window ends.

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
| commit | TEE | `close_match` (closes permissions, commit + undelegate; Books are not wiped) | anyone |
| settle | base | `finalize` (CPI `settle_match`, or `refund_match` for a draw or cancel) | anyone |

Trades are signed by the Account's wallet signer without a prompt (embedded or dev wallet), as in Hold'em; there is no separate session key.

## Known gaps

- The first caller of `end_match` picks the final tick (above).
- Liquidation is at the next price read, not at the trigger price.
- The fill log keeps the last 64 fills per Player; the trade count is exact.
- The Lead is public and reveals who is ahead by 50 Chips or more, by design.
- A backed Player can only choose the asset where the Queue link carries it (default SOL).
- Programs are devnet only; the feeds are devnet rollup copies.

## Devnet evidence

To be filled by the lead after the browser run.

## Verification

`cargo test -p trading_duel`: engine unit tests plus LiteSVM tests against the real `trading_duel.so` and `tesoro_core.so`. LiteSVM has no delegation or permission programs, so `init_permissions` and `close_match` are stood in for by writing the state they produce.
