# Block Puzzle (on-chain Game)

Async head-to-head puzzle Match. Program `block_puzzle` `5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj`, settling through `tesoro_core` `AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh`. Rules and engine: `programs/block_puzzle/src/engine.rs` (Rust) with the bit-exact port `app/src/games/block-puzzle/engine.ts`. Client: `app/src/games/block-puzzle/chain.ts`.

## Design

### Match flow

| # | Where | Instruction | Who |
|---|---|---|---|
| 1 | base | `tesoro_core::open_match` / `join_match` with `game = block_puzzle` | seat 0 opens, seat 1 joins (entry 500 / 1,000 / 2,500) |
| 2 | base | `start_session`: creates `Session` + one `Board` per Player, commits to slot `now + 3` | anyone |
| 3 | base | `reveal_seed`: Seed from that slot's hash; sets the 24 h submission deadline; asks `tesoro_core` to push the Match refund deadline past it | anyone |
| 4 | base | `delegate_boards`: both Boards to the TEE validator `MTEWGuqx...` | anyone |
| 5 | TEE | `init_permission`: Board private, member = its Player only | anyone (Player) |
| 6 | TEE | `begin_run` (starts that Player's 90 s clock), `play(moves)` (batches of at most 40), `finish` | the Player |
| 7 | TEE | `seal` + `commit_boards`: only when both runs are closed (or the deadline passed); closes permissions, commits and undelegates both Boards | anyone |
| 8 | base | `settle` (or `claim_timeout`): CPI `tesoro_core::settle_match` signed by the `["authority"]` PDA | anyone |

### Seed: nobody chooses it

`seed = H("tesoro/block-puzzle/seed" || match || SlotHashes[first slot >= commit_slot] || commit_slot)`, first 8 bytes. `start_session` commits to a slot a few slots in the future; the hash of that slot does not exist yet, so neither Player (nor the caller of `start_session`) can grind for a good Seed: the only freedom is not calling, and `reveal_seed` is permissionless. If nobody reveals within 400 slots (SlotHashes keeps 512) the next `reveal_seed` renews the commitment instead of failing, so a Match cannot wedge.

Chosen over MagicBlock VRF because the Seed is public to both Players by design (they must render the same pieces), so all that is required is unpredictability at commit time, which a future slot hash gives with no oracle, no callback and no rollup dependency. Residual trust: a leader of that slot could bias the hash by withholding a block (the standard slot-hash caveat, irrelevant at devnet stakes). VRF is the upgrade if the stakes justify it.

### Privacy

A `Board` holds a Player's whole run (move log, score). After `delegate_boards` it lives in the TEE with a private permission whose only member is its Player. `begin_run` refuses to start unless `permission_ready` is set. Devnet check (see below): while delegated, p0 reads own Board, p1 (a member of the Match) gets `null` for it, an unauthenticated TEE read gets `null`, and the base-layer copy is all zero. `commit_boards` is only allowed after `seal`, and `seal` only after **both** runs are closed, so a Player's moves become public only when the opponent can no longer play. Trust: the TEE operator (Intel TDX attestation; `verifyTeeRpcIntegrity` passes), same as ADR 0003.

### Score is a replay, never reported

`play` feeds each `(piece, x, y)` to the deterministic engine (`engine::State::apply`) on the Board's own state. An illegal move reverts the batch. The packed move log is stored so anyone can re-verify. No instruction takes a score. Measured cost: 20 moves is about 30k CU (LiteSVM), so the 40-move batch cap is far below the limit.

### Clock

- Play window: 90 s from `begin_run` plus 10 s grace for the last transaction; after that `play` fails and the run counts as closed.
- Submission deadline: 24 h from the Seed reveal. A Player who has not called `begin_run` by then forfeits.
- Enforcement is lazy and permissionless (S1 finding): `seal`, `commit_boards`, `settle` and `claim_timeout` can be sent by anyone; no keeper is required. A keeper may call them for convenience.

### Outcome

Both forfeit: draw (refund). One forfeits: the other wins (even with score 0). Otherwise higher replayed score wins; equal scores draw (refund, via `settle_match(Draw)`). `claim_timeout` covers a Match whose Boards were never delegated: after the deadline both forfeit and both entries are refunded. A Match that never reaches `reveal_seed` is refundable by anyone after the default 1 h in `tesoro_core`.

### Settlement CPI

`settle` derives the result from the committed Boards and calls `tesoro_core::settle_match` with `game_authority` = `PDA(["authority"], block_puzzle)`, registered with `register_game`. `tesoro_core` already accepted any signer equal to the registered authority, so a PDA authority needed no change (only `extend_match_deadline` was added, see `docs/tesoro-core.md`). The Session flag `settled` stops a second call here; `tesoro_core` stops it independently (status must be Active). The caller supplies the payout accounts as for `settle_match` (`chain.ts::computePayouts` ports the ledger order); accounts that do not match the program's own result are rejected by `tesoro_core`.

### Not solved (honest limits)

- The Seed is public to both Players once revealed, so a Player can precompute a solution offline before `begin_run`; the 90 s window bounds submission, not thinking, and a solver bot beats a human. Mitigation is product-level (e.g. a per-Player random tail) and out of scope here.
- The emerald gem multiplier (the Tesoro twist) lives in the engine; nothing else is Tesoro-specific on chain.
- Boards and Session are not closed after settlement (rent stays).
- Delegation and rollup steps cannot run in LiteSVM; they are covered by the devnet run below. The 24 h forfeit path is covered in LiteSVM only.

## Tests

`cargo test -p block_puzzle` (needs `pnpm build:programs`): `tests/chain.rs` runs `block_puzzle` and `tesoro_core` together in LiteSVM: Seed derivation and renewal, only Active Matches, score equals the engine replay, illegal moves rejected, play window, higher score wins with exact fees, forfeit at the deadline, unfinished runs closed by the window, draw, `claim_timeout` (early, after, and not a bypass for a played Board), only the registered authority settles, no double settle. `tests/engine.rs` covers the engine and TS parity vectors.

## Devnet run (2026-09-30)

Reproduce: `cd programs/block_puzzle/scripts && pnpm install --ignore-workspace && pnpm match` (uses `chain.ts` only). Full log: `programs/block_puzzle/scripts/evidence.json`.

Match id `1790715588874`, Match PDA `56LxbWEJwozS8fefhRTH4NXAyRn5R6N4HpxgmC9A2sq2`, Session `72tho6mvprSLxFdEEi74jx31SM7eRbDKPCpbHB3awYJg`, Boards `EcpFqQPDAUdDoMdaK61HBKXR78s9W9McMEu4yTFNjDhd` (seat 0) and `4cj4MfTNH2n5SonGeNsV3VfpdAFNFZFKg8VPfu31rBE9` (seat 1). Players `5PQmUHSZ9PJSzMymk1kW15eJ9JKXLH4b2B5gemJFMCxY` (p0) and `E1tzRJSb6qTFE5gJHs5eVUtg2axTgNbUwb9JkSXSxAui` (p1). Seed `10682468841280942559`. Result: p0 171 vs p1 55, opener wins; Gemas 75,000 / 75,000 became 75,900 / 74,000 (entry 1,000, fees 100).

Checks (all pass): TEE attestation; refund deadline pushed to submission deadline + 1 h; p0 reads own Board in the TEE; p1 gets null on p0's Board; unauthenticated read gets null; base copy all zero while delegated; committed scores equal the TS engine replay; move log public only after commit; settle pays exactly as computed; a second `settle` fails with `AlreadySettled` (6017).

| Step | Layer | Signature |
|---|---|---|
| open_match (p0, 1,000) | base | [`26LwZer1...`](https://explorer.solana.com/tx/26LwZer1YGe9XkF3SqBZzYwY8HBkoX5jq7a9ELJhpYa5ZhWjNproc28J74rDpJg4ZNC5pqcRrasMUpSftrVJDu7q?cluster=devnet) |
| join_match (p1) | base | [`3RR9M7rY...`](https://explorer.solana.com/tx/3RR9M7rYBaWaAztB6A3nVp8RDEm7HJZL6CPV5P85VKBxAqPazjcvjXHs4u8V2yDZxQAvCWSbBwzC4piiLenavNNa?cluster=devnet) |
| start_session | base | [`2EkXpeou...`](https://explorer.solana.com/tx/2EkXpeou4AJgpyGkCBvsJuo9641VL75DXCh4bijNZzXNdNQmWcskokGcJQxrtSuWY8UuvHzjnrYi7cJu9N7DfX1R?cluster=devnet) |
| reveal_seed (+ extend deadline CPI) | base | [`2PBNuFxV...`](https://explorer.solana.com/tx/2PBNuFxVfLhhUmBh73VTUyWR4XjJL7yeAyYrvMc45AFqiib9KvmNERigJTeAWtbYHEC1RsQbJ2PPJucai5M4ckL4?cluster=devnet) |
| delegate_boards | base | [`5qWZgGLA...`](https://explorer.solana.com/tx/5qWZgGLA16NyrzQ8XknbKPjaPyaaUCbVg9tt2rf4qKyNHwFeNfk2NwvZbcaWxvkm1rsSa7BdsXnpnbc1yfsYgqGT?cluster=devnet) |
| init_permission p0 / p1 | tee | `3yA11svX...` / `62KtCMWu...` |
| begin_run p0 / p1 | tee | `3esAdMTm...` / `4sjzRKLD...` |
| play p0 (30 moves) | tee | `2cCx86Uj3WsSVEgQCPybJDaJf2sMCuw6W4WLT1K4s2nGruXQQJ2Ja7e4jnGKA7wSnMedDeMuPtCRbdSw1TrRqpnZ` |
| play p1 (12 moves) | tee | `21DPtrbpULj1WGy9paGm5Cjh9DG5CNDkkuXEjtfGWvrL2eqJ8uckpiyYoPJCrmhkrRtMXzQcieHmwfVwHUcbmKkZ` |
| finish p0 / p1 | tee | `449W3Q9z...` / `2mfbb33v...` |
| seal + commit_boards | tee | `5vgTVJuYLchDNfieREFgAWRvqZez9TjYfq5G7qpVqg4y5rjETzrci7NSxrrPXKomKfFbLSY24Qwu3zNgXRRJtsTG` |
| Boards committed on base | base | [`46b5TAfC...`](https://explorer.solana.com/tx/46b5TAfCzeYWmvBnQUMkZwMBcj3oMYexb5QjmT6xExgpScpmH3BWBZRKQreoPVaHEbgDzyVw3heCEpJG3ea35m6H?cluster=devnet) |
| settle (CPI to tesoro_core as the authority PDA) | base | [`221GKqoz...`](https://explorer.solana.com/tx/221GKqoz6TyUcGQ9CCCxmgRxLsLyWhQwmKGFKnCZMkYDsKxGD6xBujYSRkVecu4kndzQmpPiwFRYh7pjJHmJGsRg?cluster=devnet) |

TEE transactions are private (redacted to outsiders), so they have no public explorer link; full signatures are in `evidence.json`.

## Browser run (2026-09-30)

A full Queue Match driven from the app in two real browser sessions at 390 px (dev-only local wallets `dev-alice`, `dev-bob`; each took the simulated demo Advance for 7,500 Gemas first, see `app/docs/demo-funding.md`). Alice pressed Enter (1,000): no open Match, so she opened one; Bob pressed Enter and joined it; each client prepared the Match (session, Seed, delegation, private permission), each played a 90 s run from the Seed with moves streamed to the TEE in batches of 4, and Bob's client settled. Alice 151 vs Bob 42, Alice won: Gemas 7,500 / 7,500 became 8,400 / 6,500 (entry 1,000, fees 100).

Match id `3581434606036`, Match PDA `5pJ7ZZPBseau46mCgLbaawWydMHnZHiXF3Nwy5pzxsc1`, Session `FQj2Yf43wxET5ntwcpSSSaG3LmfMbdk5c1pc5itBLuNV`. Base-layer signatures (TEE transactions are private):

| Step | Signature |
|---|---|
| open_match (Alice) | `4Ljpy8banow137KqfjELtcwovaqSXjkR9x4aY39YX1JwoKCFiFs2rUEV8AeqXaDkEBrJvDADh6VQg9dq8YstE5bG` |
| join_match (Bob) | `C62YLACEmF3NGhwSqPVUvRH9QWAmpkWL9fpWzURdvysm1jM7tVGzMuwcKcyaQTk5zcqer4rTnF7hQ1CZSdo1BqZ` |
| start_session (both clients raced; both landed in the list) | `2MRf2FKkuN2goUFaAUT5AhNuUDhm93bs4K1Kiop7qeTBV9DDnMCn5rutYmtQMYiJq9Lg6Z5hBbj1znRbKeU5vj33` / `4PMN6YxxHdQPmJdFwFY2SUCuHF2uhWMMBrNwWAbzGohJWD7qhjDQaU4eyvmqYAWABTM1XnL3KEPn5UqDSEQ9NdmS` |
| reveal_seed + extend deadline | `61YXtDm2j9jeRwvyGsx6MknpsyS2jPDfe9346PtcPYiwA121DYfnDBKWzJFeTkiBWDDRsZUbiVptg3mCD8Wevm78` |
| delegate_boards | `5R9QoahXju3qNfmF1qcoZh3YFQPeGhSQLbCtEMdx4M6DPyGE6XY5ZvLeELozU4ZLWjJ8fxYFw4dsgAHJgypRDMkw` / `2LkY1f9kE7eZFiyjuifGAM1Qm3qTXWTZWYrX48yzWUBXPz5pm19WKuGbUEhEYyW8ZB4wi5kiXJjFzESBLLAzoxjp` |
| Boards undelegated (commit) | `3h4FSHrRUHRosYcBZH6o7GRbtSsysxf7M7WnE6c7jNqfrnxq2xtdk86EbDfTRwbMKDdVav4xMdNYZbu9k23dSEJr` |
| settle (CPI to tesoro_core) | `4qbewWBAi7H3QjrXWyNZFXURzLLS5HG4uxf1e9ZD5mZp3BGvVuL92ncxZUKqeNKarmrsFgmxUuqrBTVrtum1qYhT` |

A Challenge (`/play/challenge?entry=500`, odd id `3581435845959`) was also opened by Alice and joined by opening its link as Bob; both clients prepared it. Screenshots: `app/docs/screens/live-*.png`.

Findings: on chain a run cannot start before an opponent joins (`start_session` needs an Active Match), so "play before an opponent is paired" is not possible yet; the app shows "Waiting for an opponent" and prepares the Match automatically the moment one joins. Queue vs Challenge is not modelled by tesoro_core; the app marks Challenge Matches with an odd Match id.

## What the app still needs (partly done: signer, IDL client, Queue, Challenge and orchestration are in the app; keeper and consolidation remain)

- Add `@coral-xyz/anchor`, `@solana/web3.js`, `@magicblock-labs/ephemeral-rollups-sdk` and `tweetnacl` to `app/package.json`; load `target/idl/block_puzzle.json` and `tesoro_core.json` and construct `new BlockPuzzleChain({ base, blockPuzzleIdl, coreIdl })`.
- A wallet adapter exposing `signTransaction` and `signMessage` (TEE auth) as a `ChainSigner`.
- UI orchestration: after `join`, either Player's client runs `startSession`, `revealSeed`, `delegateBoards`; each Player then `initPermission`, `beginRun`, streams `play` while the local engine runs the 90 s clock, `finish`; any client then `sealAndCommit` and `settle`. Validate moves with `engine.ts` before sending.
- Queue/Challenge pairing (not modelled in `tesoro_core`) and a keeper that calls `sealAndCommit`/`settle`/`claimTimeout` after deadlines.
- Payout accounts require the recipients' Holdings of each Source to exist; `chain.ts` opens missing ones.
