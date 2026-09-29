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

## Verification status

- `cargo test -p holdem`: 32 unit tests + 13 LiteSVM tests against the real `holdem.so` and `tesoro_core.so`. LiteSVM has no delegation, permission or VRF programs, so the rollup-only steps (`init_permissions`, VRF callback, `close_match`) are stood in for by writing the state they produce; `deal`, `act`, `claim_timeout`, `create_match` and `finalize` run as deployed.
- `program_autofixer` (anchor): run on the `#[program]` module and the account contexts of `create_match`, `act` and `finalize` (the instruction bodies that touch accounts and CPI): no issues. Not run on the full files.

## Known limits

- **tesoro_core refund timer.** A tesoro_core Match can be refunded by anyone 1 hour after it becomes Active (`MATCH_TIMEOUT_SECS`). A standard sit-and-go should finish well inside that (blinds reach 800/1600, over half the starting stacks, by hand 37), but a stalling pair could outlast it; tesoro_core should either extend the deadline for Matches whose Game holds them, or let only the Game authority refund an Active Match.
- The table permission lists both Players, so there is no spectator view yet.
- TEE operator / Intel TDX is the trust root for hidden state (S1). VRF late delivery cannot forfeit either Player.
- Permission PDAs use `bump` derivation (they belong to the permission program); every holdem PDA uses a stored canonical bump.
- Repeated `claim_timeout` calls are needed per action for an absent Player; the keeper should call it for stalled Matches.
