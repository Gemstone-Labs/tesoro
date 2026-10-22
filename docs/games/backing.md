# Backing (app)

Backing on Solana devnet, in the browser: a Player posts a **Request**, a Backer answers with an **Offer**, the other side accepts, and the backed Player enters a Match funded by the Backer's reserved Gemas. Terms are CONTEXT.md's (Backing, Request, Offer, Backer, Player). The money rules are `docs/tesoro-core.md`; nothing in the programs changed.

## Where it lives

| Piece | File |
|---|---|
| Chain reads and writes (Requests, Offers, records, backed open/join) | `app/src/lib/chain/backing.ts` |
| Polling hook, record and expiry text | `app/src/lib/chain/useBackingBoard.ts` |
| Backing screen (`/backing#<request>` opens the Offer drawer on that Request) | `app/src/app/backing/page.tsx` |
| A Player's Account: record, Gemas won and lost, Backings and what they did for the Backers | `app/src/app/account/[key]/page.tsx`, `app/src/components/account/`, `app/src/lib/chain/player-account.ts` (vitest) |
| Lobby "Back a Player" rail | `app/src/app/page.tsx` |
| Split display on the Match result | `app/src/components/match/BackingSplit.tsx`, `MatchView.tsx` |
| Settlement maths (`backedSplit`, `backerDelta`, backed `matchDelta`) | `app/src/lib/chain/ledger.ts` (vitest) |
| Reserved vs available Gemas | `useAccount().gemas.{reserved,available}`; Backing and Wallet screens |

## Flow

1. **Request.** A Player posts (Game, entry). The card Backers see carries the Player's real record: settled Matches with a winner, wins, win rate, always with the sample size ("1 of 1 won (100%) · 1 settled Match"). Computed from every settled tesoro_core Match of that Player (Block Burst from the Session result, Hold'em from the table).
2. **Offer.** A Backer picks a Request, sets the Player's share of the surplus (10 to 90%, 5% steps) and reserves the entry from their own Gemas. The Player accepts or declines. There are no public Offers (removed 2026-10-22): every Offer answers a Request.
3. **Reservation.** The Backer's entry is `reserved` on their Holdings: still in their balance, not spendable. The Backing screen shows Gemas in the Wallet, reserved and available; the Wallet shows a reserved line; the Lobby's Enter buttons use available Gemas. Cancel releases it; an unused or unaccepted Offer past 24h shows "Release Gemas" (`expire_offer`, anyone may call it).
4. **Expiries.** Requests and Offers show time left (24h TTL); an accepted Backing shows the 24h to start a Match.
5. **Enter.** An accepted Backing appears under "Your Backings: ready to play" with Enter the Queue and Challenge a friend, which open the normal `/play/queue` and `/play/challenge` pages with `&backing=<offer>`. The Player opens (`open_match_backed`) or joins (`join_match_backed`) with the Backer's reserved Gemas; their own Gemas are never touched and they need none.
6. **Result.** Both parties see the split. Win: Backer's entry back first, fees from the loser, then the surplus split by the Offer. Loss: the Backer bears the entry, the Player owes 0 and gains no Debt. Draw: the entry goes back to the Backer. The Backer has a "Match you funded" view (waiting, then result) and their Match history shows the split or the loss. A backed Player's history shows their share (never a negative).

## Verified in a browser (three dev-wallet Accounts, 390px, devnet)

Backer `FLAVte9W…` (Account `FLAVte9WptzNFF4JLykFa1c9tv1uRBz7Bh16qDSLPUqx`), backed Player `DA9Kg6dR…` (`DA9Kg6dR6vyTXk56iZFjc4Dc6s6xgEhkh7vDi6JhP1bS`), opponent `D1hLmTek…` (`D1hLmTekmpMoPRRNY6K1Ng8Zb8KH5tiKrYBJwHrqsRUf`). Backer and opponent took the simulated demo Advance (7,500 Gemas); the Player started with none. The Player's Match was opened with `open_match_backed`; the opponent joined the Challenge link with their own Gemas. Entry 1,000, Offer share 40%, fees 100 (5% of the 2,000 Pot, from the loser).

### Match 1: backed Player wins (73 to 0), match id 3581447022745

| Step | Signature |
|---|---|
| `create_request` (Player) | `2uhwTotrDS46KS3Srn1fNwGb9wj99zB5kaFrKDzuiZyUBsv5yacsji8taheP4aAYtVinUqcucL933qqEj6tQUiio` |
| `create_offer` (Backer, reserves 1,000) | `2CDZVhmu4wq8xVHixpemQ1DjA7eN7z1q7BNiAbhyVb61RCZvGFfSiXW5byNKLVixmrbERY57abQ5yVnLjRtD7BY7` |
| `accept_directed` (Player) | `K4jGUceLcefUbjgeff4eyWN1HiF9tZvfvqaEjhvSJ3Qh4BTnBu3E8i96CUfHCVXcjgcLBFHSQL1YBZhHnoskAz6` |
| `open_match_backed` + `open_session` (Player) | `26i3TY8Z7DmPWSQgJJCLpDgFs8Em4GbL16AXTJcar84s6ZPA3pLWd2YAPitXf254nxZCcESgt8fjjLv4Rh5UV7jT` |
| `join_match` + `join_session` (opponent) | `2YKmvkdHe6TGUx89hZQqHEvPWkf3DKsiqSRkMYHmjV2imCKi6kEhurSvkvsqGE83QQ6NC4h8piaTBi1rwmQ4cZCA` |
| `settle` (block_puzzle CPI `settle_match`) | `576rrHvzTubXfm41NUVHNzXmjwA3HPq8cmdb8ACTEdbG24AJ5cvr3qTDe1XoMB9HjErfsGMCDMVkmzWywmJ4nfDa` |

On-chain after settlement (read from the TesoroAccounts): Backer own 7,500 (6,500 after the reservation, plus the 1,000 entry back) and won 540 (60% of the 900 surplus); Player won 360 (40%), own 0, no Position, no Debt; opponent own 6,500 (1,000 entry lost). 1,000 + 540 + 360 + 100 fees = the 2,000 Pot. This matches `backedSplit`.

### Match 2: no result (0 to 0, draw), id 3581449194461

`open_match_backed` `3J6mjb65AWAaLE9WDtzoa6WuCTiNZSVfFHDf3BgrykyJyBx6zC9bM5mqxNdvLa66RWxNFvRQBkmHFkGcg7NwB1TR`, `join_match` `22FJNF88dKKKQZhK6sCEJKAdNwhC6FkxjpneiA7CXZE31YG6XvSdGkGaex9JuLciphEzh4AaJQYHNnCU1ev54g35`, `settle` `5CRo4qFk46VUJY96krtJjWRCrShn9FqBQmKChN9ZXQb8dCW2TrJYXmBHFWEmEZhSi6Ez17ZPN5isdYU1Wvw22JX`. Status `Refunded`; the Backer got the 1,000 back and the Backer's screen says "the entry went back to you". (The opponent's run did not register that time; unplanned, kept because it exercises the refund path.)

### Match 3: backed Player loses (0 to 54), id 3581452417067

`open_match_backed` `25Uo6uxJZyY5P7jBZDsAGAvediyLTyfh6aXgJ8fkQRfrD8CPY5vkeuBPZUAdptYA6SZGCB7hJXFtnPMYrRoaQdTg`, `join_match` `45BH2FMTUmdRme8tYUMBsP5SggLQnxRLpDcf8fuxAqhi5eubMVne1EXdfVvE8TvW1G4b2EZnbvUE312Rs1jcydDN`, `settle` `5LWjpXjWuGtN2dq4WopMqo965iPrYkHznqeU7415uBSsznCb6wHDdcszx9NZeDY39kA6LjRnPPZbCaaE8pq7Zbxp`. Backer own 7,500 to 6,500 (loses the entry); Player unchanged (won 360, own 0); opponent won +900 (the loser's 1,000 minus 100 fees). The Player's result screen says "Your Backer bears the loss −1,000 · You owe 0 Gemas · 0 Debt".

(A second `settle` in Matches 1 and 3 failed with an error: both clients tried to settle at once. The program rejects the second; harmless.)

## Integration notes (read before merging)

- **Block Burst flow.** The verified run used the async Block Burst flow (opener plays before being paired; `open_session` and `join_session` bundled into the Match transaction), which is what block_puzzle on devnet is deployed as now. `backing.ts` bundles those instructions when the client has `openSessionIx` and `joinSessionIx`, and does nothing extra otherwise. The devnet program no longer matches the client on this branch's base (its `reveal_seed` is gone), so **Backing needs the Block Burst app flow merged first**; the test ran on a scratch merge of this branch with `worktree-agent-ac732d5bd782d1b84`. Expect conflicts in `MatchView.tsx` (phases: theirs `queued`, mine `backer-watch`; result card), `EnterMatch.tsx`, `read.ts` (`ChainMatch.session` type versus `sides`/`backing`), `MatchHistory.tsx`, `page.tsx` and `chain.ts` (`openMatch` needs the optional `game` argument this branch's `match-flow.ts` passes). The async flow's `open` phase is `queued`, so the merged `MatchView` must not send an Open Match with a seat to a "waiting" phase.
- Hold'em: the Request, Offer and backed open/join paths are game-agnostic, and `computePayouts` in `games/holdem/chain.ts` already pays a backed side, but a backed Hold'em Match was not played. The Backer's "Match you funded" view is Block Burst only.

## Program observations and limits

- `MatchState` does not record the winner, so a Player's record is derived client-side from Block Burst Sessions and Hold'em tables. It reads every Match, Session and table; fine at devnet scale, it would want an indexer. The Account page reads the same way (`fetchAccountMatches`), and keeps the Session or table of a finished Match in memory so a poll costs only the Match list.
- A Backing can only answer a Request: there is no instruction to back a Player who has not asked. A Player's Account with no live Request says so instead of offering a button.
- The Queue is shared across everyone on devnet (other builders' Accounts were paired with mine while testing). A backed Player can be paired with anyone, including the Backer's own Accounts: the program has no rule against it.
- Requests and Offers have no display name, so the UI shows short Account keys.
- A Request stays `Accepted` forever after use; the UI hides it once no Offer is pending on it. Only one Offer per Request can be accepted; the rest lapse in 24h.
- The Offer is consumed by `open_match_backed` / `join_match_backed`; the Match an Offer funded is found by (Backer, Player, Game, entry) and newest id, since the Offer stores no Match id.
- Devnet RPC (`rpc.magicblock.app`) intermittently drops large `getProgramAccounts` calls under load ("Failed to fetch"); the Backing screen retries on its 12 s poll.
