# Vanguard: Game program

Program `vanguard` `TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH` (Solana devnet, upgradeable). Blitz Stratego on a 10x10 board, the US Army against the Royal Italian Army, in a MagicBlock Private Ephemeral Rollup (TEE). Each Player gets 20 hidden pieces and 10 seconds a move; capturing the enemy Supply Truck wins the Pot minus Fees through tesoro_core, a draw or a Match the oracle never answered refunds both entries, and a Player who never shows up loses to the one who did.

Code: `programs/vanguard/src/{lib,state,engine}.rs`. Rules in TypeScript: `app/src/games/vanguard/rules.ts`. Client: `app/src/games/vanguard/chain.ts`. Registered in tesoro_core with studio_bps 300 and the `["authority"]` PDA (see `docs/addresses.md`); no tesoro_core change was needed, as for Hold'em.

The rules are `RULES_VERSION` 6: every rank has a power, and two powers are sealed. The rules exist twice, in TypeScript (Practice, the bot, the app) and in Rust (the program). Both are tested against one set of shared recordings, so they cannot drift. The program on devnet runs version 6 since 2026-10-22.

## Rules

- Two Players, equal entry, paired through the Queue or a Challenge link. Your side (US Army or Royal Italian Army) is drawn at random, and so is the first mover.
- Each Army has 20 pieces: General of the Army (1), General (1), Colonel (1), Major (2), Captain (2), Lieutenant (2), Sergeant (2), Engineer (2), Recon (3), Spy (1), Landmine (2) and the Supply Truck (1). Pieces are dealt at random into the Player's three back rows; Landmines and the Truck never start on the front row, and no Landmine starts next to the Player's own depot.
- The two wadis (columns 3-4 and 7-8 of board rows 5-6) are impassable, except where a power says otherwise.
- A turn is 10 seconds. The program accepts a move until one second after the clock ends, and the first turn gets 10 extra seconds because the deal starts it before the Player has loaded their Army.
- **Fights.** Moving onto an enemy piece attacks it. The higher rank wins; equal ranks both leave the board. The Spy beats the General of the Army (10) whichever of the two attacks (founder, 2026-10-22). A Landmine beats every attacker and stays, so every piece, the Engineer included, loses to one. The piece that loses a fight is shown to the other side as it leaves the board, an attacker killed by a Landmine included; the Landmine that went off is shown face up for good; a defender that wins stays hidden. Moving onto the Truck captures it and ends the Match.
- **The Truck** moves one square, three times in all (its fuel), and never in two of its own turns in a row. After its third drive it is shown to the enemy.
- **Depots.** Each Army's depot sits in its own base and is raided by the other Army. A one-square step onto the enemy depot (straight or diagonal) claims it once per Match and banks a Two-Step Turn. Jumps, wadi crossings, Recon runs, Rescues and the Dust Storm never claim a depot.
- **Two-Step Turn.** Spend a banked one at the start of a turn, before moving, for two steps in the same turn. Each step is one square for every piece: a one-square diagonal for the Sergeant, any of 8 directions for the Captain, no Jumps, no wadi crossings, no runs. The Truck makes at most one of the two steps. Blast, Rescue, Dig in and Pass can't be used inside a Two-Step Turn; Become a Spy can, on either step. A Two-Step Turn ends early when no one-square step is left, and a Blast that is still possible does not keep it open.
- **Dust Storm.** Once per Match, on a turn between the 10th and the 18th, a random row or column holding at least two pieces drifts one square in a random direction. Pieces nearest the edge move first; a piece that would leave the board, enter a wadi or bump another piece stays put. The storm is blind to rank, so a dug-in Major drifts like any Landmine. A storm never claims a depot. The line and direction are drawn when the storm fires, not before.
- **Missed turns.** A turn that ends with no action, and every Pass, counts as a missed turn. Three in a row lose the Match; any move, Blast or Rescue resets the count.
- **Ending.** The Match ends when a Truck is captured, when a side has no move and no power left at the start of its turn (it loses), after three missed turns, or at the safety cap: 200 moves or 15 minutes from the start, whichever comes first. At the cap the higher total of surviving ranks wins, then the higher piece count; an exact tie is a draw. Ranks count as they are at the end: a dug-in Major counts 0 (it is a Landmine) and a switched General of the Army counts 1. Landmines and the Truck count 0. A Pass is not a move toward the 200; Blast and Rescue are.

### Powers

Every rank has a power. A "step" is one square straight.

| Rank | Name | Power |
|---|---|---|
| 1 | Spy | Beats the 10, whichever of the two attacks. |
| 2 | Recon | Runs any distance in a straight line, stopped by the first piece (which it may attack) and by wadis. |
| 3 | Engineer | **Blast.** Blows itself up: it leaves the board and is shown. Every piece on the up to 8 squares around it turns face up for good, the enemy's to the blaster and the blaster's own to the enemy. Nothing is hurt. Uses the turn. The Engineer no longer clears Landmines. |
| 4 | Sergeant | Slides like a chess bishop: diagonals only, any distance, stopped by the first piece (which it may attack) and by wadis. Never moves straight. |
| 5 | Lieutenant | **Jump.** Besides its step, it may jump one neighbouring piece (either Army, Landmines and Trucks included) straight up, down, left or right and land on the square right behind it, which must be empty (a move) or hold an enemy (an attack). It can't jump a wadi or land on one. |
| 6 | Captain | Moves one square in any of 8 directions, like a chess king. |
| 7 | Major | **Dig in.** Turns itself into a Landmine for good: it never moves again and beats any attacker. Sealed (see below), and it counts as a Pass. |
| 8 | Colonel | **Rescue.** Blows itself up (it leaves the board and is shown) and the Player's Supply Truck jumps from anywhere on the board onto its square. Everyone sees where the Truck went. Costs no fuel, works whatever fuel the Truck has left (a Truck with no fuel can be Rescued but still can't drive), works with the Colonel standing next to the Truck, and doesn't count as a Truck drive for the "never two turns in a row" rule. The Truck's trail starts over on its new square and it stays face up. Uses the turn. |
| 9 | General | Besides its step, it may jump straight across a wadi onto the first square beyond (empty, or an enemy to attack). A jump from beside a wadi that crosses no wadi square is refused. |
| 10 | General of the Army | **Become a Spy.** Turns into a Spy (1) for good, so it can beat the enemy 10 without trading. Free: it doesn't use the turn; the Player switches and then makes their action in the same turn. One way only. Sealed (see below). |
| B | Landmine | Never moves. |
| F | Supply Truck | Moves one square, three times, with the rest rule above. |

Diagonal moves may slip past canyon corners and between two pieces touching at the corners, as in chess: only the squares a piece lands on or passes through block it. Every Jump and wadi crossing obeys the shuttle rule like any other voluntary move.

A piece that is already face up may use a secret power in the open: a Blast-revealed Major that digs in, or a revealed 10 that switches, shows its new face and the table names it.

### Pass

The app has no Pass button (founder, 2026-10-22): a Player passes only by digging a Major in or by letting the clock run out, and the practice bot never passes on purpose. The program still takes a `pass` instruction, because a face-down Dig in is sent as one. A Pass counts as a missed turn, so three in a row (Passes and timeouts mixed) lose the Match, as timeouts do. It can't be used inside a Two-Step Turn or after a first step, and it doesn't count as a move toward the 200. A side with no move and no Blast, Rescue or Dig in loses at once; Passing doesn't count as an action for that.

**A face-down Dig in is a Pass in public.** It is the same instruction, carrying a sealed byte that names the Major to dig in, or nothing. Both count as a missed turn, so no counter tells the two apart. A Dig in with a sealed byte that names no Major able to dig in is just a Pass. A face-up Major's Dig in is named in the open but still counts the same way.

## What is public and what is private

| Information | During the Match | After the Match |
|---|---|---|
| Piece positions, who moved where, whose turn, clocks, depots claimed, Two-Step Turns banked, missed turns, the storm | public | public |
| The rank of a piece that has not fought, blasted or been rescued | readable only by its Player | public (the end reveal shows every piece) |
| That a piece changed rank (Dug in Major, switched 10) | readable only by its owner, unless the piece was already face up | public through the end mask |
| A Blast: the Engineer and every piece around it, with their ranks | public | public |
| A Rescue: the Colonel, the Truck and both squares | public | public |

Matches run on persistent tables (the table protocol of `docs/adr/0013-economy-upgrade.md`). A table is two public accounts, the small `Table` (epoch, phase, result ring, the VRF request) and the `Battle` (the board; one per table, reinitialised for every Match), and two `Army` seats. A seat is a rollup-only account behind a private permission, created once with the table and kept for its life: only the Player it is handed to can read it, and it can never be committed to Solana. A seat holds that Player's secret and half of the randomness until the deal, then the ranks of the side's pieces, the Truck's fuel, the sealing key and one XOR share of the storm. There is no shared Secret account. The public `Battle` holds only what has been shown. After a Match `wipe_seats` zeroes both seats and swaps their permission member to nobody before the next Match's Players are handed them, so a seat is never without a private permission, and a test checks the bytes.

### Inherent deductions

These follow from the rules and are not hidden. A Player or a spectator can draw them from the public moves:

- a diagonal run longer than one square is a Sergeant;
- a one-square diagonal is a Sergeant or a Captain;
- a jump over a piece is a Lieutenant;
- a wadi crossing is a General;
- a Blast or Rescue shows the piece that did it, and after a Rescue the Truck is known;
- a turn in which no piece moves and a missed turn is counted is a Dig in (or a Pass sent outside the app), so the opponent learns that a Major dug in, never which one; the app says so ("Their Major dug in somewhere.");
- a Spy beating a 10 may be the switched 10, and two Spies shown means the 10 switched;
- a side ending its turn means it still had an action.

The deal keeps Landmines off the squares next to a depot, but that no longer holds for the whole Match: a dug-in Major can put a Landmine there.

## Sealed powers (Dig in, Become a Spy)

The chain shows each declared action in the open: the piece number and the target square are public on purpose, because moves show on the board anyway. Ranks stay secret because they live only in the Armies. A secret power must not name its piece in the open, so its bytes are sealed with a one-time pad.

**Key.** At `deal`, each Army gets a fresh 32-byte key in its `reserved` field, readable only by its Player. It comes from a SHA-256 counter-mode stream of the setup seed (labels `seal-key-us` and `seal-key-it`), independent of the layout, side and storm streams.

**Pad.** `pad = SHA-256("vanguard-seal-v1" || key(32) || battle(32) || seat(1) || seq(u32 LE) || field(1))[0]`, where `seq` is the Battle's `action_seq` at the declare, `field` is 1 for the Dig in slot and 2 for the switch, and `sealed = plaintext ^ pad`. One plaintext is sealed per (key, seq, field), once.

- Switch plaintext: 0 for no switch, otherwise the army slot plus one of the General of the Army. Any other value, or a slot that is not the live unswitched 10, does nothing.
- Dig in plaintext (on `pass` only): 0 for a plain Pass, otherwise the army slot plus one of the Major (1 to 30). Anything else is a plain Pass.
- `move_piece`, `blast` and `rescue` always carry the sealed switch byte, and `pass` always carries both, even for "nothing", so the presence of a byte says nothing.

**Stale and retried intents.** Every declare carries `expected_seq`, public and signed, and is refused with `StaleSeq` unless it equals `action_seq`, so a payload sealed for an older seq can never decode as garbage. The client keeps the sealed bytes it built for each seq and resends exactly those on a retry; it never seals a second plaintext under the same seq, and changing one's mind after a failed send means waiting for the next turn. The program can't see failed sends, so this rule is the client's, with a test.

**Authentication.** The Player's signature and the frozen pending intent authenticate the bytes: nobody else can declare for a seat, and `resolve` takes no payload. Each of the 256 values of a sealed byte decodes to something defined, with no panics, no unchecked indexing and no secret-dependent error, even under signer impersonation in simulation. Unsealing, the switch and the Dig in check run as masks with no branch on hidden values; the public state, the errors and the compute are identical whether or not a hidden change happened.

**After the Match.** The setup seed is a hash of both Players' secrets, both halves of the oracle's answer, the table, the Match, the epoch and the request number, and it is never stored. A table does not leave the rollup in normal running, so the history of its private transactions stays filtered. If a table is ever retired or forced out, that history becomes public and the seed, the sealing keys and which Major dug in and which General switched can be rebuilt from it (the founder accepts this, 2026-10-22): the layouts and the end reveal are public at the end anyway, and no later Match is affected, because every Match has its own secrets, answer and key.

**The storm.** Its turn and its line seed are never in one place. Each seat holds a random XOR share; `resolve` combines the two for the length of one engine run. One seat alone, with the public Battle, shows a uniform number.

**Where changes are remembered.** The Army's rank bytes take two private codes: 13 for a dug-in Major (plays as a Landmine) and 14 for a switched General of the Army (plays as a Spy). Ranks of dead pieces are never cleared, so the end reveal and the owner's badge survive death and reloads. The Battle keeps an 8-byte end mask (a bit per piece id) in its reserved bytes, written only at the end, that marks every piece whose rank changed, dead ones included, so the end panel says "Major, dug in" and "General of the Army, now a Spy". The account layout is unchanged (`LAYOUT_VERSION` 2).

## Flow

| Step | Layer | Instruction | Who |
|---|---|---|---|
| open / join | base | tesoro_core `open_match`, `join_match` (game = this program id) | the two Players |
| assign | base | `assign_match(generation, index, epoch)` (write-once; the Players come from the Match, the start deadline from the clock) | the operator (keeper) |
| begin | TEE | `begin_match` (reserves a ring slot, binds the table's Battle) | anyone |
| seats | TEE | `seat_players` (swaps each seat's permission member from nobody to its Player) | anyone |
| check in | TEE | `check_in`; the second one opens setup (a minute for the secrets, three for the whole setup) | each Player |
| entropy + VRF | TEE | `contribute_entropy` (into your own seat), `request_vrf` (no argument, once per Match, bound to the table, Match, epoch, request number and both secrets); the callback `vrf_callback_store` names its request and only splits the answer into a half per seat | each Player, then anyone |
| deal | TEE | `deal` once the answer arrived (draws sides, layouts, storm; writes ranks, keys and storm shares into the seats; zeroes every secret and half) | anyone |
| move | TEE | `move_piece(piece, to, expected_seq, sealed_switch)` | the Player to move |
| powers | TEE | `blast(piece, expected_seq, sealed_switch)`, `rescue(piece, expected_seq, sealed_switch)`, `pass(expected_seq, sealed_slot, sealed_switch)` | the Player to move |
| Two-Step Turn | TEE | `start_two_step` (public, no sealed field) | the Player to move |
| apply | TEE | `resolve` (no arguments; applies the pending declare in a later slot; a decided game writes its result into the ring) | anyone |
| clock | TEE | `claim_timeout` (a missed turn, the safety cap, a start nobody finished, a stalled setup) | anyone |
| commit | TEE | `commit_table` (the table and its Battle, paid by the Sponsor; once per result, repeatable after a wait if it was lost) | anyone |
| wipe, reset | TEE | `wipe_seats`, then `reset_table` (30 s later; the ring is kept) | anyone |
| settle | base | `finalize` (reads the committed table's ring; CPI `settle_match`, or `refund_match` for a draw or cancel) | anyone |
| free the slot | TEE | `release_slot` once tesoro_core's receipt is a minute old; `void_table` if tesoro_core refunded a Match the table never finished | anyone |

Both Armies are read by `resolve` and `claim_timeout`, so those two transactions are private while the Match lives; the declares touch the Battle and the table (read only) and are public.

A Match nobody finished starting is ended by `claim_timeout` and written into the ring by who showed up (`table_kit::absence_outcome`, the founder's rule of 2026-10-23): the Player who checked in (before the start deadline) or who contributed a secret (inside the setup window) wins a normal Match with the normal Fees; if neither showed up it is a no-show (each side pays the Platform Fee). When both contributed and only the oracle's answer is missing, nobody forfeits and both entries are refunded.

A move is two steps: the Player declares it (public geometry checks: the turn, the clock, `expected_seq`, the deal slot, nothing pending, and a target on any line some rank could move along) and any account calls `resolve` in a later slot, which checks the piece's real rank. The split exists so the program never answers "is this rank allowed to go there?" in the declare, where a simulation could leak it. `move_piece`'s public check admits straight and diagonal lines, one square of 8, a straight jump over an occupied neighbour and a straight wadi crossing; the resolve decides.

A declared action the rules refuse (a Blast by a non-Engineer, a bad move) costs the turn as a missed turn at resolve and drops its switch. A broken or cheating client is the only source of these. An invalid switch does nothing and is never reported.

Declares are refused (`IllegalMove`) for Blast, Rescue and Pass inside a Two-Step Turn, after a first step, and on a Battle with `rules_version` other than 6.

## Events

The Battle keeps a ring of 16 event records, read by clients and spectators. Kinds added with the powers: `blast` (the Engineer, the square, and up to 8 piece/rank pairs), `rescue` (Colonel, Truck, from, to), `dug_in` (face-up Major only), `pass` (every Pass and every face-down Dig in, identical), `switched` (face-up 10 only). A face-down Dig in and a Pass emit exactly the same records, and a face-down switch emits nothing. A client must read at least every two actions so a record is not overwritten before it is read.

## Compute

Measured on compiled SBF in LiteSVM, whole instructions. A declare is about 4,000 to 5,100 compute units. `resolve` is roughly flat, because it does constant-work scans so it never branches on a hidden rank: about 130,000 to 148,500 on every board, with the worst case (a dense dealt board on a Dust Storm turn) at 148,483. Blast, Rescue, Pass and Dig in resolves cost 130,000 to 138,000, and a Dig in costs the same as a Pass to the unit. The client budgets are 40,000 for a declare and 200,000 for a resolve (the worst case times 1.3 is 193,000). The runtime limit is 1,400,000 per instruction, and the design's own ceiling is 600,000.

## Rules versions

A Battle stores the rules version it began under. A Match that spans a program upgrade plays on by that version (the engine keeps every earlier version's rules: four-direction steps and Engineers that defuse Landmines for version 5), and nobody can cancel it for that reason: tables are reused, so a free refund for whoever is losing would be a lever. Operators drain tables before an upgrade that changes the rules. The app decodes both versions; `defuse` stays in the decoder for that reason only.

## Verification and status

- `cargo test -p vanguard`: engine unit tests, the pad's published known answers, a golden test that pins the account layouts and the event bytes, replay of the shared recordings (305 recordings, about 8,900 actions, 260 random positions with every piece's legal targets checked), and LiteSVM tests against the real `vanguard.so` and `tesoro_core.so`: every instruction, all 256 values of each sealed byte for both seats, stale `expected_seq`, a Dig in against a Pass against an invalid Dig in under tight compute limits (same public bytes, same compute, same result), signer impersonation in simulation, a hidden change leaving the opponent's next resolve identical, a byte scan after the deal (no seed, secret, half or oracle answer in any account; each sealing key only in its own seat; the storm in no single account), a stale oracle answer after a cancel, wipe or reset, a table reused three times with every result kept in the ring until it is settled, settlement refused from the wrong table, owner or epoch, and the table and the Battle always ending together.
- `app/src/games/vanguard`: the TypeScript rules and bot (every power, Pass, the endings, the cap tiebreak with changed ranks), the seal known answers and retry ledger, the chain decoders, the owner's badge after a reload, the roster strip after a ring wrap, and the end-panel marks.
- LiteSVM has no delegation, permission, VRF or MagicBlock commit programs, so `init_seats`, the permission half of `seat_players` and `wipe_seats`, the call in `request_vrf`, the commit and the delegation are stood in for by their outputs (the instruction list that reaches the permission program is checked from the IDL).
- Devnet on the per-Match design (2026-10-22, QA Matches 3585262584381 and 3585263451521; the table design has not run on devnet yet, ticket 24): every power, Pass and face-down Dig in and switch on both sides, played on the live program. While the Match was live, neither the opponent's token nor an outsider's could read an Army or the Secret. A face-down Dig in and a Pass gave the same records (`pass`, `turn`) and the same 14-byte instruction, and a face-down switch gave a plain `move`, `turn`. After the keeper's `close_match` and `finalize`, the base-layer Armies and Secret were back with the program and wiped (ranks with codes 13/14, keys, fuel, Truck turn, move counts, entropy, VRF, storm), the end mask named exactly the changed pieces, and the tesoro_core Match settled. Record in `docs/deployments.md`.
- Findings that shape the sealing: while the accounts are delegated, listing the rollup's transaction history for them reads empty to every token, and the listing opens at `close_match`. A transaction fetched by its signature shows its instruction data to any token during the Match (seen again 2026-10-22 for `move_piece` and `pass`), which is why the switch and Dig in bytes are sealed.

## Known limits

- The pad is a one-byte one-time pad: it is perfect secrecy only while one plaintext per (key, seq, field) is ever sent. The client's retry rule is the guard; the program can't see failed sends, and a new tab with cleared storage could seal a second plaintext under the same seq.
- The inherent deductions above are not hidden, and Sergeants, Lieutenants and Generals reveal themselves when they use their power. The Dust Storm and the sealed powers keep some fog.
- A Truck whose three neighbours are Landmines or wadis can only be reached by a Lieutenant jump; once the enemy has no live Lieutenant left it can't be captured and the safety cap decides. The bot simulation below tracks how often that happens.
- Ranks are checked in `resolve` in a later slot than the declare, so a refused move costs the turn.
- Programs are devnet only.

## Bot simulation report

Regenerate with `pnpm --filter @tesoro/keeper exec tsx ../app/scripts/vanguard-sim.ts --seed 1 --count 3000 --write ../docs/games/vanguard.md` (about 2.5 minutes: five runs of 3000 Matches). Same seed and count give the same report. `--chain-ms` replaces the assumed 0.5 s.

<!-- sim-report:start -->

Seed 1, 3000 Matches per run, bots on the app's rules engine (RULES_VERSION 6, with powers). The first side to move alternates, so each army moves first in half of them. Pace per action: 2-3 s thinking, 0.5 s chain time, plus the board's animation (slides, flip, storm). Every run uses the same seeds, so the layouts match across runs.

The **standard** bot uses the powers (Rescue when an enemy stands by its Truck, Blast when 3+ hidden enemies surround an Engineer, a Major digs in early beside its Truck or depot, the 10 becomes a Spy only to attack a shown 10). The **fortress** bot digs both Majors in around its Truck and otherwise plays like standard. **Before powers** is the version-5 rules (4-direction steps, Engineers defuse, no powers) with the plain bot on both sides, rerun on the same seeds with `version: 5` and policy `plain`, so the two columns below differ only in the rules and the bot's new options.

### Standard vs standard, before and after powers

For reference, the report written before powers (seed 1, 3000 Matches, the engine and bot of that day) read: 108 / 170 / 200 moves, 83.5% Truck, 11.6% no legal move, 4.9% cap, first mover 49.5%, US Army 51.6%. The "before" column below is a rerun on today's code with `version: 5` and the plain bot, and it does not reproduce that file exactly (the bot has changed since; the cause was not isolated), so compare the two columns to each other, not to the old file.

| Measure | Before powers (v5, plain) | With powers (v6, standard) |
|---|---|---|
| Moves per Match (median / p90 / max) | 107 / 167 / 200 | 95 / 167 / 200 |
| Wall-clock length, minutes (median / p90 / max) | 6.2 / 9.5 / 11.5 | 5.6 / 9.5 / 11.6 |
| Ended by Truck captured | 89.5% | 86.6% |
| Ended by no legal move | 4.6% | 6.5% |
| Ended by safety cap (moves / time) | 5.9% (5.9% / 0.0%) | 6.9% (6.9% / 0.0%) |
| Ended by timeouts | 0.0% | 0.0% |
| Draws | 0.1% | 0.1% |
| First mover wins (of decided) | 48.7% (of 2998) | 49.0% (of 2996) |
| US Army wins / Royal Italian Army wins | 51.2% / 48.8% | 48.4% / 51.6% |
| Sealed Truck at some turn start (either army) | 0.0% | 0.1% |
| Sealed Truck among cap endings | 0.0% of 178 | 0.0% of 207 |
| Two-Step Turns spent per Match | 1.03 | 1.01 |

Sample size: 3000 Matches per column. Half a percentage point is within the noise at this size (about 1.8 points at 95% for a 50% rate).

### How often each power is used (standard vs standard)

| Power | Uses per Match | Share of Matches using it |
|---|---|---|
| Dig in (Major) | 1.84 | 91.2% |
| Blast (Engineer) | 0.10 | 9.4% |
| Rescue (Colonel) | 1.03 | 80.2% |
| Become a Spy (General of the Army) | 0.00 | 0.2% |
| Sergeant diagonal run of 2+ squares | 5.41 | 98.7% |
| Captain diagonal step | 8.74 | 94.8% |
| Lieutenant jump | 3.78 | 93.7% |
| General wadi crossing | 0.76 | 56.9% |

Movement powers count the move that uses them (a Sergeant run, a Captain's diagonal, a jump, a crossing); Dig in, Blast, Rescue and Become a Spy count the action. The bot's Become a Spy needs a shown enemy 10, which blind play rarely produces.

### Fortress against standard

| Run | Matches | Truck / no move / cap / timeouts | Fortress side wins | First mover wins | Sealed Truck (any turn start) | Sealed among cap endings |
|---|---|---|---|---|---|---|
| Fortress = Royal Italian Army | 3000 | 83.0% / 8.4% / 8.6% / 0.0% | 49.5% (of 2997) | 50.0% | 0.4% (0.4% on the fortress side) | 1.9% of 259 |
| Fortress = US Army | 3000 | 83.3% / 7.9% / 8.7% / 0.1% | 49.7% (of 2999) | 50.1% | 0.2% (0.2% on the fortress side) | 0.8% of 262 |

Uses per Match in the fortress runs: Dig in 2.14 (Italian fortress), 2.12 (US fortress), against 1.84 in standard vs standard.

### Without the caps

The same 3000 standard Matches replayed with the move and time caps lifted (limit 3000 moves reached). Share still running past a limit:

| Moves | 100 | 150 | 200 | 250 | 300 | 400 |
|---|---|---|---|---|---|---|
| Share past it | 44.6% | 13.2% | 6.9% | 5.4% | 5.0% | 3.9% |

| Minutes | 10 | 15 | 20 | 30 |
|---|---|---|---|---|
| Share past it | 9.0% | 5.2% | 4.1% | 3.4% |

Uncapped, the median Match runs 95 moves (p90 167, 5.6 min median, 9.5 min p90).

### Dust Storm

The storm turn is drawn from turns 10 to 18 (a turn is one side's go). It fired in 95.3% of standard Matches, moved at least one piece in 92.6% and three or more in 60.4%. The median uncapped Match has 93 turns; 5% end before turn 15. The first attack, usually a Recon probe, comes after 6 moves.

### Flags

Thresholds from the spec: cap decides more than 5%, first mover wins more than 55%, a sealed Truck in more than 10% of Matches. Checked on all three runs.

- Standard vs standard: the safety cap decides 6.9% of Matches (threshold 5%).
- Fortress (Royal Italian Army) vs standard: the safety cap decides 8.6% of Matches (threshold 5%).
- Fortress (US Army) vs standard: the safety cap decides 8.7% of Matches (threshold 5%).

### Options if the cap flag stands (nothing is applied)

- Raise the move cap (and the time cap with it, or the clock still ends the Match first). Share of standard Matches still running past 250 / 300 / 400 moves: 5.4% / 5.0% / 3.9%; past 15 / 20 / 30 minutes: 5.2% / 4.1% / 3.4%. The rules use 200 moves and 15 minutes. A higher cap only moves the line; the shuffling Matches just run longer.
- Add a no-progress ending: a set number of moves in a row with no attack, depot step or action ends the Match on the cap tiebreak. It targets the bot's shuffling directly and leaves honest long Matches alone; it is a new rule and needs a counter on the Battle.
- Leave the rules and read the flag as the bot's shuffling (probably, not measured): the cap decided 5.9% of Matches before powers on the same seeds (see the first table), and a human is unlikely to shuffle. Decide after Practice.

### Proposal (the rules are unchanged)

- Move cap: no tested value leaves at most 3% still running; 400 still leaves 3.9% because the bot shuffles pieces without finishing (the rules use 200).
- Time cap: no tested value leaves at most 3% still running; 30 minutes still leaves 3.4% (the rules use 15).
- Storm window: turns 10 to 18. 95% of Matches run past turn 15, so a later storm still lands; a wider window makes the hidden storm turn harder to guess. The placeholder is 10 to 18.

### What this does not tell us

The bot plays blind and simply: it never reads the opponent's hidden ranks, pushes forward, attacks with strong pieces and probes with Recons. Its use of the powers is a fixed recipe: it digs in early and rescues when an enemy touches the Truck, but it never plans a Blast, never bluffs with a switch, never deliberately hunts a sealed Truck with a Lieutenant, Sergeant or Captain, and never builds a fortress unless the fortress policy is on. A human who walls the Truck in on purpose, or who attacks a walled Truck on purpose, will see a different sealed-Truck share than the bot does, in either direction. The switch of the General of the Army is almost never used by the bot, so its balance is untested here. Human Players will be slower on some turns and more decisive on others, so these numbers bound the rules, they do not predict Match length or fairness. Human playtests come next and should replace this pace.

<!-- sim-report:end -->
