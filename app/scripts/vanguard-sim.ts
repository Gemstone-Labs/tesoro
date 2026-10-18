/**
 * Plays seeded Vanguard Matches between two copies of the practice bot and prints the Match length report.
 *
 *   pnpm --filter @tesoro/keeper exec tsx ../app/scripts/vanguard-sim.ts [--seed 1] [--count 3000] [--chain-ms 500]
 *     [--think-min 2000] [--think-max 3000] [--write ../docs/games/vanguard.md]
 *
 * Same seed and count give the same report. --write replaces the report section of the Vanguard game doc.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PACE, aggregate, renderReport, runBatch, type Pace } from "../src/games/vanguard/sim/simulate";

const args = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const v = Number(args[at + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} needs a non-negative number`);
  return v;
};
const seed = num("seed", 1);
const count = num("count", 3000);
const pace: Pace = { thinkMinMs: num("think-min", DEFAULT_PACE.thinkMinMs), thinkMaxMs: num("think-max", DEFAULT_PACE.thinkMaxMs), chainMs: num("chain-ms", DEFAULT_PACE.chainMs) };
if (!Number.isInteger(count) || count < 1) throw new Error("--count needs a positive whole number");

const started = Date.now();
const real = runBatch({ seed, count, pace });
const probe = runBatch({ seed, count, pace, capMoves: 3000, capMs: 6 * 3600_000 });
const report = renderReport(aggregate(real, pace), { seed, count, pace }, aggregate(probe, pace));
console.log(report);
console.error(`${count * 2} Matches in ${((Date.now() - started) / 1000).toFixed(1)} s`);

const out = args.indexOf("--write");
if (out >= 0) {
  const file = resolve(args[out + 1]);
  const start = "<!-- sim-report:start -->";
  const end = "<!-- sim-report:end -->";
  const doc = readFileSync(file, "utf8");
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${file} has no ${start} ... ${end} section`);
  writeFileSync(file, `${doc.slice(0, a + start.length)}\n\n${report}\n\n${doc.slice(b)}`);
}
