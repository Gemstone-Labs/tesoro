# Block Burst (on-chain Game)

Async head-to-head puzzle Match. Program `block_puzzle` `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj`, settling through `tesoro_core` `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh`. Rules and engine: `programs/block_puzzle/src/engine.rs` (Rust) with the bit-exact port `app/src/games/block-puzzle/engine.ts`. Client: `app/src/games/block-puzzle/chain.ts`.

The opener plays before an opponent is paired (Queue: "Play now, you'll be paired"); the second Player plays later against the same Seed. Nobody, including the Player themself, can see the piece sequence before their own run begins.

## Design

### Match flow

| # | Where | Instruction | Who |
|---|---|---|---|
| 1 | base | `tesoro_core::open_match` (`game = block_puzzle`, entry 500 / 1,000 / 2,500) + `open_session` (same transaction) | seat 0 (`open_session`: anyone) |
| 2 | base | `delegate_opener`: opener's `Board` and the `SeedVault` to the TEE validator `MTEWGuqx...` (any other validator, or none, is refused: audit F-01) | anyone |
| 3 | TEE | `init_vault_permission` (private, **zero members**), `init_permission` (Board private, member = its Player) | anyone |
| 4 | TEE | `request_seed(client_seed)`: VRF request; the oracle's callback `seed_callback` writes the Seed only into the SeedVault. `check_seed` succeeds once it is there | anyone |
| 5 | TEE | `begin_run`: copies the Seed into the beginning Player's own Board and starts their 90 s clock; `play(moves)` (batches of at most 40); `finish` | the Player |
| 6 | base | `tesoro_core::join_match` + `join_session` (same transaction): creates seat 1's Board, extends the Match refund deadline | seat 1 (`join_session`: anyone) |
| 7 | base | `delegate_joiner`: the joiner's Board to the TEE | anyone |
| 8 | TEE | joiner: `init_permission`, `begin_run`, `play`, `finish` (same Seed) | the Player |
| 9 | TEE | `seal` + `commit_boards`: only when both runs are closed (or deadlines passed); closes permissions, wipes the SeedVault, commits + undelegates both Boards and the SeedVault | anyone |
| 10 | base | `settle` (or `claim_timeout`): CPI `tesoro_core::settle_match` signed by the `["authority"]` PDA | anyone |

Nobody joins: `tesoro_core::refund_match` (the opener at once, anyone after the Match deadline) returns the entry. Steps 2 to 5 do not depend on step 6.

### Signatures (Anchor accounts)

`open_session`: `payer` (signer, mut), `match_state` (tesoro_core Match, Open, this Game), `account_a` (opener's TesoroAccount), `session` (PDA `["session", match]`, init), `board_0` (PDA `["board", session, 0]`, init), `vault` (PDA `["vault", session]`, init), `system_program`.
`join_session`: `payer`, `session` (mut), `match_state` (mut, Active), `account_b` (joiner's TesoroAccount), `board_1` (PDA `["board", session, 1]`, init), `authority` (PDA `["authority"]`), `config`, `tesoro_core_program`, `system_program`.
`delegate_opener`: `payer`, `session`, `board_0`, `vault`, `validator` (+ delegation accounts). `delegate_joiner`: `payer`, `session`, `board_1`, `validator`.
`init_permission`: `payer`, `board`, `permission`, `permission_program`, `ephemeral_vault`, `magic_program`. `init_vault_permission`: same with `vault`.
`request_seed(client_seed: u8)`: `payer`, `vault`, `oracle_queue` (the delegated default VRF queue) + VRF program accounts. `seed_callback(randomness: [u8; 32])`: only the VRF program identity can sign. `check_seed`: `payer`, `vault`.
`begin_run`: `player` (signer), `board`, `vault`. `play(moves: Vec<MoveArg>)`, `finish`: `player`, `board`.
`seal`: `payer`, `board_0`, `board_1`. `commit_boards`: `payer`, `board_0`, `board_1`, `vault`, `permission_0`, `permission_1`, `vault_permission`, `permission_program`, `ephemeral_vault`, `magic_context` (+ program).
`settle`, `claim_timeout`: `payer`, `session`, `board_0`, `board_1`, `authority`, `config`, `match_state`, `tesoro_core_program` + payout accounts as `remaining_accounts` (as for `settle_match`).
Removed from the previous version: `start_session`, `reveal_seed`, `delegate_boards`.

### Seed: nobody chooses it, nobody sees it early

Requirements: fixed before the opener plays; unpredictable at open time; the joiner must not learn the opener's moves; nobody may precompute the piece sequence before their run.

`seed = first 8 bytes of H("tesoro/block-puzzle/seed" || match || vrf_output)`, computed **inside the private rollup**. After `delegate_opener` the SeedVault is in the TEE with a private permission that has no member, so no wallet can read it (docs/spikes/S1.md did the same for the Hold'em Deck). `request_seed` asks the MagicBlock VRF oracle from inside the TEE; the callback writes the output only into the SeedVault, once (`SeedAlreadyDrawn`). Nothing about the Seed touches the base layer, so it cannot be known at open time, and the opener cannot grind (the request is one-shot, and the output is not readable). It is fixed before the first `begin_run`, which requires `vault.ready`.

`begin_run` is the only instruction that moves the Seed: it copies it into the beginning Player's own Board (readable only by that Player) in the same transaction that starts their clock. The Board's `seed` is 0 before that, so the piece sequence reaches a Player only when their run begins. The client reads it back from its own Board (`beginRun` returns it). The Seed becomes public only when the Boards commit (settlement copies it into the Session).

Trust: the TEE operator (Intel TDX attestation, `verifyTeeRpcIntegrity` passes) and the VRF oracle, who could tell a Player the Seed early by colluding with them. Same trust root as ADR 0003. What changed against the slot-hash design: the Seed is no longer public between reveal and play, so offline solving before the timer is not possible. Remaining, bounded: a Player can run a solver during their own 90 s window (the window bounds thinking, as in any timed game); the per-run 90 s clock, not secrecy, is the limit there.

### Privacy of moves

A `Board` holds a Player's whole run. In the TEE it has a private permission whose only member is its Player. `seal` needs **both** Boards in the rollup and both runs closed (or their deadlines passed); `commit_boards` needs `sealed`. With one Board only (before a joiner exists) neither can run, so the opener's moves stay private until the joiner's run is closed, and the joiner never sees them earlier. The base-layer copy is all zero while delegated. Trust as above.

### Score is a replay, never reported

`play` feeds each `(piece, x, y)` to the deterministic engine (`engine::State::apply`) on the Board's own state. An illegal move reverts the batch. The packed move log is stored so anyone can re-verify. No instruction takes a score. 20 moves is about 30k CU (LiteSVM).

### Clock

- Play window: 90 s from `begin_run` plus 10 s grace for the last transaction.
- Opener: must `begin_run` before `Session.opener_deadline` = the Match's Queue window end (24 h from `open_session`) plus 24 h, else forfeits. That is never earlier than the joiner's deadline (join + 24 h), so a late join cannot forfeit an opener who has not begun. `open_session` also accepts a Match that was joined before its Session existed.
- Joiner: 24 h from `join_session` (`Session.deadline`); the `tesoro_core` refund deadline is pushed to that plus 1 h. `join_session` must land within the 1 h `tesoro_core` gives an Active Match: the app sends it in the same transaction as `join_match`, and any client binds a Match joined without it (`ensureJoined`).
- Enforcement is lazy and permissionless: `seal`, `commit_boards`, `settle` and `claim_timeout` can be sent by anyone. If a Player never delegated their Board, anyone can delegate it (`delegate_opener` / `delegate_joiner`) and create its permission, then seal (that Player forfeits); this path is in the app (`bringForfeitedBoardsIn`) but was not run on devnet (it needs a 1 h or 24 h wait).

### Outcome

Both forfeit: draw (refund). One forfeits: the other wins (even with score 0). Otherwise higher replayed score wins; equal scores draw (refund, via `settle_match(Draw)`). `claim_timeout` covers a joined Match whose Boards were never delegated: after the deadline both forfeit and both entries are refunded. A Match nobody joins is refunded by `tesoro_core`.

### Queue window

`tesoro_core` gives an Open Match `MATCH_TIMEOUT_SECS` = 1 h. `open_session` pushes that out to `QUEUE_WINDOW_SECS` = 24 h through the Game authority (`extend_match_deadline` now accepts an Open Match), so an opener who plays before pairing is not refundable for a day; the opener can still cancel at once. A join after the window fails (`Expired`) and anyone may refund. A Match opened without `open_session`, or before this change, keeps its 1 h.

### Settlement CPI

`settle` derives the result from the committed Boards and calls `tesoro_core::settle_match` with `game_authority` = `PDA(["authority"], block_puzzle)`, registered with `register_game`. The Session flag `settled` stops a second call here; `tesoro_core` stops it independently. The caller supplies the payout accounts (`chain.ts::computePayouts` ports the ledger order); accounts that do not match the program's own result are rejected by `tesoro_core`.

### Not solved (honest limits)

- The Seed and every hidden run rely on the TEE operator and the VRF oracle.
- An opener who cancels (refunds) before anyone joins has seen their own score for free; nobody else is affected, but the Board and the SeedVault of an unjoined, refunded Match stay delegated (a few thousand lamports of rent) because the rollup cannot see the base-layer Match.
- A Match joined by a client that skips `join_session` (an older app) is bound by any client within 1 h; otherwise it is refundable by anyone.
- Devnet Queue is global: other builds of the app share it.
- The emerald gem multiplier lives in the engine; nothing else is Tesoro-specific on chain.
- Delegation and rollup steps cannot run in LiteSVM; they are covered by the devnet runs below.

## Tests

`cargo test -p block_puzzle` (needs `pnpm build:programs`). `tests/chain.rs` runs `block_puzzle` and `tesoro_core` together in LiteSVM:

- session: only an Open Match of this Game with the opener's Account; once per Match; not after the Queue window; join binds only the Account that joined, deadline math, refund deadline extended, once only;
- opener plays a full run before anyone is paired (Match still Open, entry escrowed), cannot be sealed before a joiner exists, joiner plays later and gets the same Seed, opener wins / joiner wins, exact fees;
- privacy of the Seed: it is in the SeedVault and in no other account (Session, either Board) until `begin_run`, then only in the beginning Player's Board; no run begins before the Seed is drawn; nobody starts another Player's run;
- score equals the engine replay, illegal moves rejected, play window, draw, unfinished runs closed by the window, opener who never begins forfeits at their window, joiner who never begins forfeits after 24 h;
- no join: the opener cancels at once, anyone refunds after the window, a late join fails;
- `claim_timeout` (early, after, not a bypass for a played Board), only the registered authority settles, no double settle.

LiteSVM has no delegation program, VRF or permissions: the VRF callback is emulated by writing the SeedVault, and the read-permission checks (SeedVault unreadable, opponent Board unreadable) are asserted on devnet by the script. `tests/engine.rs` covers the engine and TS parity vectors.

## Devnet (2026-09-30)

Program upgraded in place (`solana program deploy` to `https://rpc.magicblock.app/devnet`, upgrade signature starts `2AM5YvGuqQKr`, data length 537,776 to 613,392). Old Boards/Sessions of the previous layout no longer decode; all earlier Matches were settled.

### Scripted async Match

Reproduce: `cd programs/block_puzzle/scripts && pnpm install --ignore-workspace && pnpm match` (uses `chain.ts` only). Full log: `programs/block_puzzle/scripts/evidence.json` (last run).

Match id `1790719867058`, Match `GFc5vwF69X1NQ7P6biAKGVmToGqvgpFBPULZmanjt1k1`, Session `7LNUAwcSXxXEuCPWB62EkaLjGeAju5TsZ8JhNjJkC6ym`, SeedVault `pLPuzLd5c7zmr3qkexbDNMsnMeq2U2fAkifKZMuxYfu`, Boards `3RPZkPgGrvs1DmoHxC7iKKWRWYhMcnVeaJb7dHBtYje1` / `733uEpzK3r3F4nddZc2EGF8Tka47NdEyuDoD4TepMoQV`. Players p0 `5PQmUHSZ...` and p1 `E1tzRJSb...`. Seed `10223678449608242028`. p0 (opener) opened, prepared, played 30 moves and finished while the Match was still Open; 20 s later p1 joined and played 12 moves. Result 297 vs 70, opener wins: Gemas 75,900 / 74,000 became 76,800 / 73,000.

Checks (all pass): TEE attestation; p0's own Board holds no Seed before `begin_run`; VRF callback wrote the Seed (`check_seed` succeeds); **the SeedVault reads `null` for p0, p1 and an unauthenticated client**; base copy of the SeedVault holds no Seed; opener finished while the Match was Open; p0 reads own Board; unauthenticated read of p0's Board fails; base copy of p0's Board has no moves and no Seed; join extended the refund deadline past the submission deadline; p1 cannot read p0's Board; **`seal` is refused while the joiner can still play**; p1's Board holds no Seed before `begin_run`; p1 receives the same Seed at `begin_run`; committed scores equal the TS engine replay; second `settle` fails (`AlreadySettled`, 6015).

| Step | Layer | Signature |
|---|---|---|
| open_match + open_session (p0) | base | [`5sATS6Rz...`](https://explorer.solana.com/tx/5sATS6RzekG45wCkUfJ7qmPEhVi521fNvCgDWX9ySFMW46p33CG25FNLLpnahXEMSydZY5dWAhkKRSc7ndaC8egR?cluster=devnet) |
| delegate_opener | base | [`3YpZqjaE...`](https://explorer.solana.com/tx/3YpZqjaEvXSvYxxHb3HhCAcS5Qb5ZnYxdFsatsB3qdCsMtdFWd19BnJCYQCJLKxwPC92j3ywCtXe9p4iuaa7xchu?cluster=devnet) |
| init_vault_permission / init_permission p0 / request_seed / begin_run p0 / play p0 / finish p0 | tee | `2f2LrPQX...` / `5kthjX5f...` / `3q3a9DdL...` / `2j5nxoeb...` / `66DjRg2t...` / `4UnzN3ts...` |
| join_match + join_session (p1) | base | [`2npQFi9m...`](https://explorer.solana.com/tx/2npQFi9mNJ7KBynMKea6VvVWSQ7wEP5hJ9VkCmxrWH5DipumMCbKSDHJNEU1NTjeiZ35AsdnEM3TMLYBXDpsp4fh?cluster=devnet) |
| delegate_joiner | base | [`2Du5rmxp...`](https://explorer.solana.com/tx/2Du5rmxpX547QVxadTe9GwLJ53dwKWvbDMz3zh6bSqXqA4HzbJFMiF1vhKnDjhThoqFNf6u9qTtSrwf41upyruF5?cluster=devnet) |
| init_permission p1 / begin_run p1 / play p1 / finish p1 / seal + commit_boards | tee | `4Q26rbvn...` / `Yfp77DhE...` / `2mjhiMCA...` / `4VwMK6Se...` / `5uReBFH3...` |
| Boards + SeedVault committed on base | base | [`3nd1pMGb...`](https://explorer.solana.com/tx/3nd1pMGbPrTG3V5enz5LU118nDGd4tQXjrJR4NbarB4UUod6hn8kPfgYA6eFZdPVhgr9dEDmMFFtVuCpVUrxqr9B?cluster=devnet) |
| settle (CPI to tesoro_core as the authority PDA) | base | [`KK3MY8Dj...`](https://explorer.solana.com/tx/KK3MY8Djm3GqKAe5oroW61NVXdeNjYyGKFm4fSz8fVxcGYc8GeA99vcQjsjZbzxryJJxvtFkWFXSU2nRfz7gVss?cluster=devnet) |

TEE transactions are private (redacted to outsiders); full signatures are in `evidence.json`.

### Browser runs

Two real browser sessions at 390 px (dev-only local wallets `dev-asyncA` "Alice", `dev-asyncB` "Bob"; each took the simulated demo Advance for 7,500 Gemas first). The run was driven by tapping pieces and cells; runs were short.

1. **Challenge, opener first (decisive).** Match `3581444286081` (Match PDA `CQSN1n85od4SdtLo7FDaEeUHR1ZuH8qP4keML4GAti3F`, Boards `AzEZ9CK3npmXhixePfhTJL4F6HAtT2Hsu58SJYSHbveG` / `EES14j66qrvaaktM6EYbFCMKU3zeep5f6xsgeRR4Bm3R`, SeedVault `45V6eVBCsCcy1z6qi7H35jGbwVh7qT6n7nhtpJ4Sbf9P`). Alice opened a Challenge, prepared her run and played it to 208 at 05:52:36 (+07) while the Match was Open. At 05:52:44 Bob opened the link, joined, prepared, pressed Start and let the clock run out (began, score 0). Alice won: settled by Bob's client. Base signatures of the Match: open `2ULWX16F51Gf5MUrYfGU5eP1PovWnf852joVoCQaNWsqeNv94GzWCDWMUxkonk6uhDzQksXMw2XfJk68UNDa2wui`, join `F9Tzv5S2c1KprLxAbJtF8eqzpBQFtULy5ZHUTA6bxtFrD66NVK7wHAWueRH3c7JWo1Yu3Ufivv3VaeW4ejDUKeg`, settle `dXZG9ynkHgSKay8dp4f3PK5DVE32EwEKCz6yM5uJ1UDHZPqiLgAxQj8MgwTAwNV3nSWiyiBSobYWTopLtL3Vq8R`. Seed `0x8e5f4b5590fcf1a9`, copied into the Session at settlement.
2. **Queue.** Match `3581441434678`: Alice pressed "Play now" (no Match to join, so she opened one) and played to 115; Bob pressed "Play now", joined it, played the same Seed with the same taps and also scored 115: a draw (equal scores prove the same Seed), both entries returned (settle `3fzC2fzsGN...`).
3. **Interop finding.** An older build of the app on the shared devnet Queue joined one of these Open Matches with a bare `join_match` (no `join_session`), leaving it Active but unbound. That is why `ensureJoined` exists; that Match is refundable by anyone after its 1 h deadline.

## What the app still needs

- A keeper that calls `seal`/`commit_boards`/`settle`/`claim_timeout` after deadlines (the client does it opportunistically).
- The 24 h Queue window (see Queue window).
- Consolidating the Hold'em/other Game screens with the "Play now" wording; only Block Burst copy was changed here.
- Payout accounts require the recipients' Holdings of each Source to exist; `chain.ts` opens missing ones.
