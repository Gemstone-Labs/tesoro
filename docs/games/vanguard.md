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
| Ended by Truck captured | 83.4% |
| Ended by no legal move | 11.4% |
| Ended by safety cap (moves 5.2%, time 0.0%) | 5.2% |
| Ended by timeouts | 0.0% |
| Draws | 0.1% |
| First mover wins (of 2997 decided) | 49.9% |
| US Army wins / Royal Italian Army wins | 52.1% / 47.9% |
| Two-Step Turns spent per Match | 1.02 |

Bot note: in 268 Two-Step Turns the practice bot picked a Recon's long run and then spent the Two-Step Turn, which makes that run illegal (the engine refuses it). The sim lets the bot pick again; Practice does not, so Practice can hang on such a turn.

### Without the caps

The same 3000 Matches replayed with the move and time caps lifted (limit 3000 moves reached). Share still running past a limit:

| Moves | 100 | 150 | 200 | 250 | 300 | 400 |
|---|---|---|---|---|---|---|
| Share past it | 57.4% | 15.8% | 5.1% | 2.9% | 2.2% | 1.9% |

| Minutes | 10 | 15 | 20 | 30 |
|---|---|---|---|---|
| Share past it | 8.7% | 2.6% | 2.0% | 1.4% |

Uncapped, the median Match runs 108 moves (p90 170, 6.3 min median, 9.7 min p90).

### Dust Storm

The storm turn is drawn from turns 10 to 18 (a turn is one side's go). It fired in 97.1% of Matches, moved at least one piece in 95.6% and three or more in 63.4%. The median Match has 107 turns; 5% end before turn 42. The first attack, usually a Recon probe, comes after 3 moves.

### Flags

- The safety cap decides 5.2% of Matches (threshold 5%).
- With a turn clock that keeps running during animations, 2.6 actions per Match would pass the 5 s turn after thinking, chain time and the opponent's animation. The practice screen rebases the clock after each animation; the on-chain clock does not.

### Proposal (the rules are unchanged)

- Move cap: 250, the smallest tested value that leaves at most 3% of Matches still running (the rules use 200). About 2% of Matches are still running after 400 moves because the bot shuffles pieces without finishing; a human would not.
- Time cap: 15 minutes by the same test (the rules use 15).
- Storm window: turns 10 to 40. 95% of Matches run past turn 42, so a later storm still lands; a wider window makes the hidden storm turn harder to guess. The placeholder is 10 to 18.

### What this does not tell us

The bot plays blind and simply: it never reads the opponent's hidden ranks, pushes forward, attacks with strong pieces and probes with Recons. It does not bluff, defend a Truck on purpose or plan a depot raid. Human Players will be slower on some turns and more decisive on others, so these numbers bound the rules, they do not predict Match length. Human playtests come next and should replace this pace.

<!-- sim-report:end -->
