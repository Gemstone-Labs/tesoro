/**
 * p50 / p95 of the Match timings written by match-timing.mts, plus the keeper's own lines for the same Matches.
 *
 *   node scripts/match-timing-report.mjs rows1.json [rows2.json ...] [--keeper-log keeper.txt]
 *
 * Every number is milliseconds after the joining transaction landed ("join"), or after time's up ("times_up"), as the script
 * saw them (observer polls ~400 ms apart; the pages' stages come from the pages' own driver). The keeper log is
 * `journalctl --user -u tesoro-keeper -o cat` output; its lines are matched by the Match key's first four characters and
 * the opener's counter, as the keeper prints them (`match=7k1s…-0`).
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const logAt = args.indexOf("--keeper-log");
const keeperLog = logAt >= 0 ? readFileSync(args[logAt + 1], "utf8") : "";
const files = args.filter((a, i) => !a.startsWith("--") && (logAt < 0 || (i !== logAt + 1)));
const rows = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8"))).filter((r) => !r.error && !r.timedOut);

const after = (a, b) => (r) => (r[a] != null && r[b] != null ? r[b] - r[a] : null);
const metrics = [
  ["join landed -> table assigned (keeper)", after("join", "assigned")],
  ["join landed -> Match page 'setup' (A, B worst)", (r) => (r.A_stage_setup != null && r.B_stage_setup != null ? Math.max(r.A_stage_setup, r.B_stage_setup) - r.join : null)],
  ["table assigned -> seats handed over", after("assigned", "t_seated")],
  ["seats handed over -> both checked in", after("t_seated", "t_checkin_both")],
  ["both checked in -> Seed in", after("t_checkin_both", "t_seed")],
  ["Seed in -> clock started", after("t_seed", "t_started")],
  ["clock started -> play begins (get-ready, 10 s by design)", after("t_started", "play_begins")],
  ["JOIN LANDED -> PLAY BEGINS", after("join", "play_begins")],
  ["JOIN LANDED -> page shows the game (A, B worst)", (r) => (r.A_stage_playing != null && r.B_stage_playing != null ? Math.max(r.A_stage_playing, r.B_stage_playing) - r.join : null)],
  ["time's up -> table closed", after("times_up", "t_closed")],
  ["closed -> committed in the rollup", after("t_closed", "t_committed_tee")],
  ["committed in the rollup -> committed on base", after("t_committed_tee", "t_committed_base")],
  ["committed on base -> result fixed on chain (finalize)", after("t_committed_base", "core_settling")],
  ["result fixed -> Match stage Closed (chunks)", (r) => (r.core_settling != null && Math.min(r.A_stage_settled ?? 1e12, r.core_closed ?? 1e12) < 1e12 ? Math.min(r.A_stage_settled ?? 1e12, r.core_closed ?? 1e12) - r.core_settling : null)],
  ["TIME'S UP -> RESULT FIXED ON CHAIN", after("times_up", "core_settling")],
  ["TIME'S UP -> RESULT SHOWN (A, B worst)", (r) => (r.A_stage_settled != null && r.B_stage_settled != null ? Math.max(r.A_stage_settled, r.B_stage_settled) - r.times_up : null)],
  ["time's up -> Match account closed", after("times_up", "core_closed")],
];

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const sec = (ms) => (ms / 1000).toFixed(1).padStart(6);
console.log(`${rows.length} Matches`);
console.log(`${"".padEnd(58)} ${"n".padStart(3)} ${"min".padStart(6)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)}  (seconds)`);
for (const [name, f] of metrics) {
  const xs = rows.map(f).filter((x) => x != null);
  if (!xs.length) continue;
  console.log(`${name.padEnd(58)} ${String(xs.length).padStart(3)} ${sec(Math.min(...xs))} ${sec(q(xs, 0.5))} ${sec(q(xs, 0.95))} ${sec(Math.max(...xs))}`);
}

if (keeperLog) {
  console.log("\nKeeper lines per Match (seconds after the join landed):");
  for (const r of rows) {
    if (!r.key || r.join == null) continue;
    const label = `${r.key.slice(0, 4)}…-${r.key.split("-").pop()}`;
    const t0 = r.t0 + r.join;
    const lines = keeperLog.split("\n").filter((l) => l.includes(`match=${label}`) && /DONE/.test(l));
    const parts = lines.map((l) => {
      const at = Date.parse(l.slice(0, 24));
      const what = (l.match(/DONE (\w+)/) ?? [])[1] ?? "?";
      return `${what} +${((at - t0) / 1000).toFixed(1)}`;
    });
    console.log(`  ${label}: ${parts.join(", ") || "(no keeper action lines)"}`);
  }
}
