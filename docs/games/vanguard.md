# Vanguard: Game doc

> **DRAFT.** The bot simulation report below was regenerated for the powers (RULES_VERSION 6). Ticket 12 writes the rest of this doc (rules, program, client, evidence).

Vanguard is Tesoro's fourth Game: blitz Stratego on a 10x10 board, US Army against the Royal Italian Army. Rules in TypeScript: `app/src/games/vanguard/rules.ts`.

## Bot simulation report

Regenerate with `pnpm --filter @tesoro/keeper exec tsx ../app/scripts/vanguard-sim.ts --seed 1 --count 3000 --write ../docs/games/vanguard.md` (about 2.5 minutes: five runs of 3000 Matches). Same seed and count give the same report. `--chain-ms` replaces the assumed 0.5 s once ticket 01 has measured the rollup.

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
