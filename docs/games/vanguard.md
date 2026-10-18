# Vanguard: Game doc

> **DRAFT.** Ticket 03 wrote only the Match length report below. Ticket 12 writes the rest of this doc (rules, program, client, evidence).

Vanguard is Tesoro's fourth Game: blitz Stratego on a 10x10 board, US Army against the Royal Italian Army. Rules in TypeScript: `app/src/games/vanguard/rules.ts`.

## Bot simulation report

Regenerate with `pnpm --filter @tesoro/keeper exec tsx ../app/scripts/vanguard-sim.ts --seed 1 --count 3000 --write docs/games/vanguard.md` (about 30 s). Same seed and count give the same report. `--chain-ms` replaces the assumed 0.5 s once ticket 01 has measured the rollup.

<!-- sim-report:start -->

Seed 1, 3000 Matches, two copies of the practice bot on the app's rules engine. The first side to move alternates, so each army moves first in half of them. Pace per action: 2-3 s thinking, 0.5 s chain time, plus the board's animation (slides, flip, storm).

| Measure | Result |
|---|---|
| Moves per Match (median / p90 / max) | 108 / 170 / 200 |
| Wall-clock length, minutes (median / p90 / max) | 6.3 / 9.7 / 11.6 |
| Ended by Truck captured | 83.5% |
| Ended by no legal move | 11.6% |
| Ended by safety cap (moves 4.9%, time 0.0%) | 4.9% |
| Ended by timeouts | 0.0% |
| Draws | 0.0% |
| First mover wins (of 2999 decided) | 49.5% |
| US Army wins / Royal Italian Army wins | 51.6% / 48.4% |
| Two-Step Turns spent per Match | 1.03 |

### Without the caps

The same 3000 Matches replayed with the move and time caps lifted (limit 3000 moves reached). Share still running past a limit:

| Moves | 100 | 150 | 200 | 250 | 300 | 400 |
|---|---|---|---|---|---|---|
| Share past it | 57.5% | 16.1% | 4.8% | 2.9% | 2.3% | 1.9% |

| Minutes | 10 | 15 | 20 | 30 |
|---|---|---|---|---|
| Share past it | 8.6% | 2.6% | 2.0% | 1.5% |

Uncapped, the median Match runs 108 moves (p90 170, 6.3 min median, 9.7 min p90).

### Dust Storm

The storm turn is drawn from turns 10 to 18 (a turn is one side's go). It fired in 97.0% of Matches, moved at least one piece in 95.5% and three or more in 63.4%. The median Match has 106 turns; 5% end before turn 41. The first attack, usually a Recon probe, comes after 3 moves.

### Flags

- No threshold crossed: the cap decides at most 5% and the first mover wins at most 55%.
- With a turn clock that keeps running during animations, 2.6 actions per Match would pass the 5 s turn after thinking, chain time and the opponent's animation. The practice screen rebases the clock after each animation; the on-chain clock does not.

### Proposal (the rules are unchanged)

- Move cap: 250, the smallest tested value that leaves at most 3% of Matches still running (the rules use 200). About 2% of Matches are still running after 400 moves because the bot shuffles pieces without finishing; a human would not.
- Time cap: 15 minutes by the same test (the rules use 15).
- Storm window: turns 10 to 40. 95% of Matches run past turn 41, so a later storm still lands; a wider window makes the hidden storm turn harder to guess. The placeholder is 10 to 18.

### What this does not tell us

The bot plays blind and simply: it never reads the opponent's hidden ranks, pushes forward, attacks with strong pieces and probes with Recons. It does not bluff, defend a Truck on purpose or plan a depot raid. Human Players will be slower on some turns and more decisive on others, so these numbers bound the rules, they do not predict Match length. Human playtests come next and should replace this pace.

<!-- sim-report:end -->
