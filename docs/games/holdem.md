# Hold'em (heads-up No-Limit) — Game program

Program `holdem` `CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE` (Solana devnet, upgradeable). One sit-and-go per tesoro_core Match: both Players start with 1,500 Chips, blinds rise on a hand-count schedule, hands repeat until one Player holds every Chip. Chips never leave the Match; the Pot is settled once in tesoro_core, as a win (Pot minus Fees) or a refund.

Design basis: `docs/spikes/S1.md` (hidden Deck, private hole cards, settle round-trip) and ADR 0003. Code: `programs/holdem/src/{lib,state,engine,eval}.rs`. Client: `app/src/games/holdem/chain.ts`. Devnet driver: `programs/holdem/scripts/play.ts`.

## Flow and layers

| Step | Layer | Instruction | Who |
|---|---|---|---|
| open / join the Match | base | tesoro_core `open_match`, `join_match` (game = holdem id) | the two Players |
| bind a table to it | base | `create_match(match_id, speed)` | either Player (checks the tesoro Match is Active, of this Game, and the two `TesoroAccount`s are its Players) |
| delegate to the TEE | base | `delegate_match` | anyone |
| permissions + start | TEE | `init_permissions` | anyone |
| each hand: secrets | TEE | `contribute_entropy(secret)` x2, `request_vrf` | each Player; the second bundles the VRF request |
| each hand: deal | TEE | `deal` | anyone, once the VRF output arrived |
| betting | TEE | `act(Fold / Check / Call / Raise{to})` | Player to act |
| clock | TEE | `claim_timeout` | anyone |
| commit back | TEE | `close_match` (wipes, closes permissions, commit + undelegate) | anyone, once over or cancelled |
| settle | base | `finalize` (CPI into tesoro_core `settle_match` or `refund_match`) | anyone |

`finalize` signs the CPI as the Game authority with the `["authority"]` PDA of holdem (canonical bump stored in the table). That PDA is registered in tesoro_core as this Game's authority: `register_game(game = holdem id, authority = PDA, studio_bps = 300)`. **No tesoro_core change was needed:** its `SettleMatch.game_authority` is an Anchor `Signer`, which a PDA satisfies when the calling program uses `invoke_signed`. This is proven by the LiteSVM tests against the real `tesoro_core.so` and by the devnet Match below.

## Rules implemented (`engine.rs`, pure and unit-tested)

- Heads-up: the button posts the small blind and acts first preflop; the big blind acts first after the flop; the button alternates each hand.
- Actions: fold, check, call, bet/raise (`Raise{to}` is the total for the street), all-in is `to = bet + stack`. Min raise = the last full raise (bets open at the big blind); a short all-in is allowed but does not change the minimum; no raising against an all-in opponent; uncalled chips are returned; both all-in runs the board out.
- Board: flop, turn, river come off the hidden Deck and are copied into the public table as they are dealt. No burn cards (the deck is unknowable, so burning adds nothing).
- Showdown: 7-card evaluator (`eval.rs`), ties split the pot. Only at a showdown are the two Players' hole cards copied into the public table (`last_shown`); a fold reveals nothing.
- Blind schedules (`speed`): Standard = 25/50 rising every 4 hands to 800/1600; Turbo (demo) = 50/100 rising every hand to 800/1600. The last level repeats, so a Match always ends.
- Turn clock: 30 s per action, 60 s to contribute entropy at the start of a hand.

## Hidden information (as S1 proved, now per hand)

Deck: zero-member permission. Seed = `H(entropy || vrf || hand_no)`, `entropy` folds both Players' fresh per-hand secrets, `vrf` is the MagicBlock VRF output delivered by callback into the private Deck. Hole accounts: private to their Player. The table: private to both Players. `close_match` wipes Deck and Holes before committing, so nothing hidden reaches the base layer.

Devnet check (all PASS, `programs/holdem/scripts/evidence.json`): each Player reads only their own hole cards; the opponent's hole cards, the Deck, and (for an outsider) the table all read as `null`; the base-layer copies show zeros mid-match and after the commit.

## Clock and forfeits

- `claim_timeout` (permissionless, TEE): an idle Player to act is checked, or folded when facing a bet. A missed-turn counter resets on any voluntary action; **three in a row forfeit the Match**.
- No-show: if the table was never started before `start_deadline` (5 min from creation), `finalize` refunds via tesoro_core. If a Player never contributes entropy to hand 1, `claim_timeout` cancels the Match and `finalize` refunds both entries. In a later hand the absent Player forfeits; both absent cancels.
- If both Players contributed but the VRF output is late, `claim_timeout` only extends the deadline (nobody forfeits) and `request_vrf` can be re-sent.

## Evaluator tests (`eval.rs`)

Known-hand tests for all 9 categories, the wheel (A-5) in straights and straight flushes, broadway vs king-high, royal vs lower straight flush, flush vs straight built from off-suit cards, full house from two trips / trips plus two pairs / mixed sets, quads kickers, two pair from three pairs, board-plays ties, a strict category ladder, and a **200,000-hand randomized cross-check against an independent slow reference** (best of all 21 five-card subsets). `engine.rs` adds the rule tests plus a 400-match random-play test asserting chips are conserved every action and that every Match terminates.

## Devnet evidence (Solana devnet + MagicBlock devnet TEE, 2026-09-30)

Players (test wallets) `BQoGqkAWidhczrNni7GC2ypmPTxL3Wh1Whj58gRePPy2` (seat 0, opener) and `FwJirzRfTM8VBS7f45WjpxYFvTrtXo6AydkaSSYQKfZg` (seat 1). Entry 500 Gemas each (simulated Positions and Advances, so simulated Gemas). TEE transactions are private and have no public explorer page.

Program upgrade deploy: `65jW2XxV6Bh1y8XPmafEidUDKf2yxxqpVt27Aao5vLbRf6rADTaec4sGbQ9ie9k5zQ1A9BdDHwyHBQRFX53oUx5C`. Game registration with the PDA authority `Eu2RtadRsFCV9Xe2A7v7GivS9W5Trbrz6tCagNRUCwtn` (tesoro_core `register_game`): `2eLBr7oYRtQE5RRVrDdSZZ63wXyaM1nbLZH8Bq65G6Jr9pdm5a1BXHJb74G9koqoksgDYqXzx2QmkcKLRtvbccaj`.

### 1. Full Match (turbo), 3 hands: check-down showdown, then shoves; seat 1 wins all 3,000 Chips

Match id `1790715657340`, table `5UdtBvaARNc5Vo7du2XUTzrxcThPbmzeUPgMks8UNtT7`. Winner received 950 Gemas (own 500 + loser's 500 minus the 5% Platform + Studio Fee). 18 checks PASS.

| Step | Layer | Signature |
|---|---|---|
| tesoro_core open_match | base | [`2T4PkCak...jDpA8H`](https://explorer.solana.com/tx/2T4PkCakHy1mK8HhH7yWRunsohzcjopSACQ9h6xLysVCqRPFsJK9V1p5L94cp1FqePNMQR4SdvKG6PRdJNjDpA8H?cluster=devnet) |
| tesoro_core join_match | base | [`g4kGzHvD...zzw1`](https://explorer.solana.com/tx/g4kGzHvDDMnvwxrpNYzvv6gV8xP5qA1mKCWAQfGuwtLwaQYjYknvHjWomsQiSeEebBitsqtu6FNfGXfv7WVzzw1?cluster=devnet) |
| create_match | base | [`4Foge7ar...ptrn`](https://explorer.solana.com/tx/4Foge7arCz9xhzJgtkaTZHqtkLcSvzw3DZGbrdrYHWSPdfAT6XFeNECsyWpgMAwKkL32agsUW2PkffWgVZXtoprn?cluster=devnet) |
| delegate_match | base | [`5TAqmDHw...ugNH`](https://explorer.solana.com/tx/5TAqmDHwuUBL7gyUYfhpgdUDs6bsU6hP9FxWxoWH9aeveGCB6WzHntffKqz2mUsmP2dQzk8FuwcLMQGZBuA1ugNH?cluster=devnet) |
| init_permissions (start) | tee | `454MSkepnCzfHpkvJ1cSvxphnNP5uGVHuAHuDsAekkZcXDb8zvhyXiecyG2LN1PaxwSY1ueV7B5BBKfB5wZcaLoL` |
| hand 1: contribute_entropy x2 (+VRF), deal | tee | `5oq9HTYt...MWrwK`, `5V1Xw1JP...9EikK`, `2W7TfJ73...8xt` |
| hand 1: call, 7 checks to showdown | tee | `3hr6oTGk...`, `LdKUK3by...`, `4zsC8ayi...`, `3NZsMhvk...`, `BqBzyE8Y...`, `sHQZS2Gh...`, `5pDVqtLc...`, `96Q2cWV2...` |
| hand 2: entropy x2, deal, call / raise / call | tee | `3YBFnemo...`, `4Hzjaa4z...`, `2gi6B3yg...`, `3bq5A7eP...`, `JuCqsttg...`, `5ZqX2C42...` |
| hand 3: entropy x2, deal (blind all-in runs out, Match over) | tee | `3gJYGQ8x...`, `3vKZ7wJW...`, `3FQwDb4y...` |
| close_match (wipe, close permissions, commit + undelegate) | tee | `4bKVVpUeTVrSifAYedXtKUEyVLarGVkLUusBQxbYXAB5yMZqbVp2GSt1HDZ3A9QgUos5XYArhtS7CapHYAnu8icb` |
| close_match commit | base | [`5wrapuqA...UVN7`](https://explorer.solana.com/tx/5wrapuqAsFzfF4SkVCBiUZJDG9kQFSLTAU1qk4AUZUPTG8f99UzwuMPAN8ni7S5jUi82VvKQXtPWB1aCVkbTTUVm?cluster=devnet) |
| **finalize (CPI settle_match, signed by holdem PDA)** | base | [`bQ9xvM9F...STFj`](https://explorer.solana.com/tx/bQ9xvM9FZAtcykus5TXu7QRrQChHxpiapPR5riin6EsEYUiZorchKTREkA39WQXPryCh2y4u6k3biPLGaG1STFj?cluster=devnet) |

Full signatures for every row are in `programs/holdem/scripts/evidence.json`.

### 2. No-show refund

Match `1790715851010`: seat 1 never contributed entropy; after 60 s a third party called `claim_timeout` (cancelled), then `close_match` and `finalize` refunded both entries through tesoro_core (`refunded`, both Players +500).
`claim_timeout` (tee) `2jJb1hh4BBwUnoFanGW8z9nfwKXLCWnxVykvQeSPZHjFSxvyvgaGECa7yrwfKV72mzRj72WFdq1y7QcBRvUtAz2Q`; `finalize` (base) [`4vZiuDrw...E7LTq`](https://explorer.solana.com/tx/4vZiuDrwKu3hzyjHqm966yrC5ssptfzYmCBNeJarSi24w3bvxscXpRqWeDbM4Nz1BBBJoDnNU4dyJyRzDFyE7LTq?cluster=devnet).

### 3. Idle Player: auto-fold, auto-check, forfeit after three misses

Match `1790716013129`: seat 0 idle for three turns; three permissionless `claim_timeout`s (tee) `zS5KEbSH...`, `2RywHich...`, `CkGwwaCx...` (the third forfeited it), `finalize` (base) [`3oMzpshR...p61Ma8`](https://explorer.solana.com/tx/3oMzpshR19q92sNTQ1FPi6pxarb5qpxDq6DwWnHo6hYLVhqC4xDzoj5WTeXhbRVtQvNCXnMaLk8F92THCop61Ma8?cluster=devnet). Present Player +950. Signatures in `evidence-idle.json` and `evidence-noshow.json`.

## Browser evidence (web app, two dev-wallet Accounts, devnet + TEE, 2026-09-30)

The table is in the web app: Lobby Hold'em card (entry 500 / 1,000 / 2,500) → Queue (`/play/queue?game=holdem&entry=500`) or Challenge link (`/play/challenge?game=holdem`) → Match page (`/play/match/<id>`, which picks the Hold'em view from the tesoro_core Match's game). Code: `app/src/games/holdem/` (`useHoldemMatch.ts` drives the non-betting steps in call order `create_match`, `delegate_match`, `init_permissions`, then per hand `contribute_entropy` (each Player) + `request_vrf` + `deal`, and at the end `close_match` + `finalize`; both clients run it, one first and the other after a grace period, and a lost race is harmless). Demo Matches use `SPEED_TURBO`. Two headless Chromium sessions (agent-browser, 390 x 844) signed in as `dev-alice` (`HMohE...rLR8`) and `dev-bob` (`7gEK...vof3`), each funded with the demo Advance (7,500 simulated Gemas), entry 500. TEE transactions are private (no public explorer page); base-layer signatures link to Solana Explorer.

Screens (390px) in `app/docs/screens/holdem-*.png`: Lobby, waiting for an opponent, Challenge link, table setup, dealing, own hole cards, showdown reveal, fold result, bet slider, claim timeout, match over, Won and Lost results; `holdem-desktop-1280.png` for desktop.

### A. Queue Match `3581438379834` (alice opened, bob joined from the Queue): 4 hands, alice wins all 3,000 Chips

Exercised in the browser: check/call preflop and postflop, a bet to 400 from the slider (Pot preset), a showdown (bob wins with a kicker on a paired board), a **Claim timeout** by bob after alice's 30 s clock ran out (alice auto-folded, "Missed 1 of 3 turns" shown), all-in and call, showdown reveal, then close and settle. Table `6dgo62iGtBjjPGw4AqEX75myJp7BSCeKNK2dr85zo6fi`. alice +450 Gemas (won 950 back of 500 entered, 50 Gemas fees), bob -500.

| Step | Layer | Signature |
|---|---|---|
| tesoro_core open_match (alice) | base | [`5hRuEcT9...LsexQ`](https://explorer.solana.com/tx/5hRuEcT9Dq5LLPzadRPq6pcKxVXVN6pYbcppQwKbni4NZVxEo1n1gYHBcWyMwgnc9MCtxuh9k5cecgf2HM3LsexQ?cluster=devnet) |
| tesoro_core join_match (bob) | base | [`4KdtGSaQ...ve1nC3`](https://explorer.solana.com/tx/4KdtGSaQTET5QowiLve886mwDxn3B2Wn8zjcGzePAGtTUFyXAayn7UzKzziFT5NHsSsfqGotZ5vAuMVpugve1nC3?cluster=devnet) |
| create_match (bob) | base | [`4UMHbDk8...tUZJ`](https://explorer.solana.com/tx/4UMHbDk8fc3txXQA7K45Ti1aLhMacjU1bGNiAoUxa4q2jyundC3sNyGydH6kTTBa2rrDetNeBVB8GnMr8c4WtUZJ?cluster=devnet) |
| delegate_match | base | [`SCMiQTK3...T9u8BqXniV6`](https://explorer.solana.com/tx/SCMiQTK3VHQYcdytAxE5wRiXuvwAQzWFBNAzW5ThTKJ35HLMex5x3gkKqzuLBPEKHRPPGDPmeEk6T9u8BqXniV6?cluster=devnet) |
| init_permissions (bob) | tee | `2ZEv5xHtJRoRzndBMZDAhjM1AjE2je7uw1XVncgrmRRuR6hu5qjP4iP5KirxbBLUeArbQ5HD2PF6QYrAGznryhy7` |
| hand 1: entropy (bob), request_vrf, deal | tee | `3GQpoX3wTakQoxnx7wwN3v8qZxUFCRFPC5dTgJh5XTNoeEwJuQrGp1KKqZ7BxpATAqP5F577Lo19aU82tkP2BRcN`, `4KVjj5n9rzxfkYhwEAbksv3Ns9Jfv8Tzesh8kr2gxNf1swkyFZEBh9DWD2EwiZrCMUcfLbzLrgQcXGcFbbGyrnfL`, `5izkw2RwXortxmvtazG2x172QZzNMEY2aU32dqyP4AW3HfnyPyRYu7fKLtkbWiuCA6By12vfRaJ7NdTLiMw3niuE` |
| hand 1: **claim_timeout** by bob (alice idle, auto-folded) | tee | `4Spj93NQXFF2DA2VvBSEsj7iCs6CtKt7V9bvqcLZ8WnNAn31RAhXrwuDd2RYQFWDc1ipCfaxFmcvV495qNqpMDTY` |
| hand 2: entropy, request_vrf, deal | tee | `3BAb5cRWKnsz9jQd4oKpAiob52kcMZwRqtExEqSdTy9nmyxE9j2NQ3aCA25onqtbq8qGyCE6ipxdiP1Fkbtqco6T`, `2ibHEekDR7EqPZqBSWGLpLiDP4P8MYYHUjghhCfiH6ET46MTZRwPXh9JkhL2hv74xeBQiBC1gf9UfmSmUoroDWE`, `5zADVcA1RqUHMCbrM1AAaqZ5wuy8cTmwmoUVtBW4umapwvf9uUvS6pxKahfRakUfqaQgnPu3ccSmYJiuGXMWdpsc` |
| hand 2: bob call 100; alice check; **alice bet to 400**; bob call 400; check, check, check, check to showdown | tee | bob call `61XM9xE6BP4MZA1pa382Tq3NHocYt9P3pH2C2KsrErkRF1LZeAzWPaPRTpzVxRQAgzFUMaikwohBvZRoGNPy96mS`, alice bet `Fqt8xxy1s7DKb47Ke4zo7u8iGa2m4QLcvbRgAF3q64wczPAxQdXvQrG5pC5mcGk54UNCTVQof5444h7XRrxTW4X`, bob call `234U1sWsaNgpxhmpfbx8c6TwJ4hQqMXKXtodaBmUg4Jj85SHnZMM45FxBMBRi53Tk5Mg1C2nxUjVrHEKT9hrX6CF` |
| hand 3: entropy x2, deal, alice all-in, bob call 450 | tee | alice all-in `4KnwjScUJm5k7oqhAiisnb8mWwTXwg9EqYsNDti5zFuGtNQgWvLHsuY3RyJ4XvY21vjBP1h4HJPUCJUEM1PueXmG`, bob call `v3fa7BHENjLUHJ1HBHx1sPhT3ECziVoQjhabZjjmEaYQuHBfn9PR5jBRPkRiAE6T8F9mhFqh4eHLoZV9mmnTzoq` |
| hand 4: entropy x2, deal, bob all-in 900, alice call 500 | tee | bob all-in `2UrcPhmdaGvGPxU2sz7Bgq7UWC6q9LCPiPLP2s3X8jp65eJcB1nJVRzxNGH37shDAaqwbRpymerdYYfFqHmwyD8e`, alice call `4j9DfqZEUL1qD95tM9kjKU6G8yBheGnNbivLKTEnELionBv4TT5RhR3Jn53UCSJqfjq21Jo894J7E8uEJ2uMxLw7` |
| close_match (alice: wipe, close permissions, commit + undelegate) | tee | `4QmbvmS9JJLha22nj4Qy5eSYzDPkGzBi4fXoEjEVaLL4hSxf5BfkQPXvXnGPe7FxjjRT338kXyZMCHxqNULgb6R9` |
| close_match commit | base | [`3rnCCe7z...FRsQ`](https://explorer.solana.com/tx/3rnCCe7zEQvA9oSnZcMwsxYLhQp2koXUo5UqXEmQtoPSZpKxUszgBXEjSdWAMeCSu84nBag2twa58QfjFZSxFRsQ?cluster=devnet) |
| **finalize (bob's client, CPI settle_match)** | base | [`4uBFPi6V...v1cNc`](https://explorer.solana.com/tx/4uBFPi6VTkcreqk5BfHuEJ4Xu9jkBSJ5rWUSUW74CGVrNmMxhhpL94xFMdQBMTEYYAc16DuggY4cKkQ6ki6v1cNc?cluster=devnet) |

### B. Challenge Match `3581439372503` (alice created the link, bob opened it): 2 hands, alice wins

Challenge link flow, table set-up screen, a bet/raise from the slider (alice raise to 200, bob **folds**: "Your opponent folded" result, no cards revealed), then bob all-in and alice call, showdown, settle. Table `9WHGjsn4ZTfJyvRUJu6qCmgQsD6H8u8FcjU5BFRvsxdv`. alice +450 Gemas, bob -500.

| Step | Layer | Signature |
|---|---|---|
| tesoro_core open_match (alice, Challenge) | base | [`3CQz5FLt...K8k3`](https://explorer.solana.com/tx/3CQz5FLt4nW9MuT27iGMaNa4B7sDmAUgoXaoaeJHaT2ccstAw8pEUd9UiLaTj6uq7ST3dH8Mdru1cyBDak6KK8k3?cluster=devnet) |
| tesoro_core join_match (bob, from the link) | base | [`zQf7mUEQ...q7tT2`](https://explorer.solana.com/tx/zQf7mUEQ9Nyv8pdiCigm4xpWzGvtAub8KQbrYRwpZ3QUNYm4JmYCJFHhsyEEErbxRGucV286uxPMj2AUP9q7tT2?cluster=devnet) |
| create_match | base | [`5ks5qPdq...9Gjsmw`](https://explorer.solana.com/tx/5ks5qPdqefvQhz6uRN3VvDKFeRyqcK4AF4hCdsaR2CJKr4k7YPpJTAKRmTMHAoUY7TBQTuFnA5bkcX5t1i9GJsmw?cluster=devnet) |
| delegate_match | base | [`3AYFpFp5...zJwZV`](https://explorer.solana.com/tx/3AYFpFp5rB8mcrerThUdqcGnZpANXLi7yMraUVSey9ygP96P3HdPJPYW8sXc19AfqYwxh3MZckBWpFjAjd4zJwZV?cluster=devnet) |
| init_permissions | tee | `4UL2MfpdzhoQmzRHuQn1S7NEXLeJgMXhixQknrTycXZKWFwC6B5UA7scsC1nZ4rdmBwDm4fdE1QkdJVCzzQisRYX` |
| hand 1: entropy x2 (+VRF), deal, alice raise to 200, bob fold | tee | alice raise `2B8DwoTt1bhpJJAo79j9gEQYYTrUS1FKNzXfS4ns6Ge9judYku8NWudGZy5K85yuFx1ofj8XBGegVtoXp4g5iMqH`, bob fold `TEuaV9cztgsALFMuiEnWvnnY1JrxXBULNNpesoosotPAnWz9YxSxr74z1oBs7ZRRFRjh4e77VFAZWw4ww5TPYCd` |
| hand 2: entropy x2, deal, bob all-in, alice call | tee | bob all-in `49Xk96UgzDvKAXs3Q1i7JAPH4NVoX59YcrHDcerQp8A3knD85jyZHe8rmXdi422WnFr3rJk7jsoZxuygsiGqT8ZU`, alice call `2TAXP7yjFRvZSoRC4EyQBRNmt89k5XNgLpvGQF2HP9xAreVw5XWBoNuSn57ECHq6k2idsj6bBds86MBBvCjpViVW` |
| close_match commit | base | [`SHMPbU1f...paTsP8`](https://explorer.solana.com/tx/SHMPbU1f3SCprGdQGxWDpv5ajMeVRDdbR4b1p3GycUi9PbZjhwDT6AeGyyTbF2eWQpPxXaJHhatHUDvcqpaTsP8?cluster=devnet) |
| **finalize (bob's client, CPI settle_match)** | base | [`5Rci41rk...eb15H6`](https://explorer.solana.com/tx/5Rci41rkTv5PX9MTXrvTUEry49o6dTdy9sNx58hwqEgVe3wvzP2FWwdhUF8TTSaqVSVMmhn8hgDof3MCKebe15H6?cluster=devnet) |

Alice's client also sent a second `finalize` (`5c7im2hM...`) that failed with the Match already settled: both clients try, the loser of the race is harmless (tolerated in `useHoldemMatch.ts`).

## Verification status

- `cargo test -p holdem`: 32 unit tests + 13 LiteSVM tests against the real `holdem.so` and `tesoro_core.so`. LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps (`init_permissions`, VRF callback, `close_match`) are stood in for by writing the state they produce; `deal`, `act`, `claim_timeout`, `create_match` and `finalize` run as deployed.
- `program_autofixer` (anchor): run on the `#[program]` module and the account contexts of `create_match`, `act` and `finalize` (the instruction bodies that touch accounts and CPI): no issues. Not run on the full files.

## Known limits

- **tesoro_core refund timer.** A tesoro_core Match can be refunded by anyone 1 hour after it becomes Active (`MATCH_TIMEOUT_SECS`). A standard sit-and-go should finish well inside that (blinds reach 800/1600, over half the starting stacks, by hand 37), but a stalling pair could outlast it; tesoro_core should either extend the deadline for Matches whose Game holds them, or let only the Game authority refund an Active Match.
- The table permission lists both Players, so there is no spectator view yet.
- TEE operator / Intel TDX is the trust root for hidden state (S1). VRF late delivery cannot forfeit either Player.
- Permission PDAs use `bump` derivation (they belong to the permission program); every holdem PDA uses a stored canonical bump.
- Repeated `claim_timeout` calls are needed per action for an absent Player; the keeper should call it for stalled Matches.
