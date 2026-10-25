/**
 * Turns the JSONL files of scripts/turn-latency-spike.ts (one per machine) into the numbers of ticket 01.
 *
 *   tsx scripts/turn-latency-report.ts laptop.jsonl vps.jsonl
 */
import { readFileSync } from "node:fs";
import { lateRate, percentile, summarize, type Summary } from "../src/turn-stats.ts";

const TURN_SECS = 5;
const MOVE_AFTER = Number(process.env.MOVE_AFTER ?? 4500);
type Rec = Record<string, any>;
const load = (f: string): Rec[] => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: turn-latency-report.ts <jsonl>...");
const runs = files.map((f) => load(f));
const label = (r: Rec[]) => r[0].label as string;
const fmt = (s: Summary) => `n=${s.n} min ${s.min.toFixed(0)} p50 ${s.p50.toFixed(0)} p95 ${s.p95.toFixed(0)} p99 ${s.p99.toFixed(0)} max ${s.max.toFixed(0)} ms`;

const landed = new Map<string, Rec>();
for (const r of runs.flat()) if (r.type === "landed") landed.set(r.sig, r);

for (const run of runs) {
  const moves = run.filter((r) => r.type === "move");
  const ok = moves.filter((m) => !m.err);
  const sends = run.filter((r) => (r.type === "move" || r.type === "ping") && r.marks && !r.err);
  console.log(`\n## ${label(run)}: ${moves.length} moves sent, ${moves.length - ok.length} with an error, ${run.filter((r) => r.type === "turn-failed").length} turns that never started`);
  const span = (Math.max(...moves.map((m) => m.at)) - Math.min(...moves.map((m) => m.at))) / 60000;
  console.log(`spread over ${span.toFixed(1)} min`);
  const span2 = (Math.max(...sends.map((m) => m.at)) - Math.min(...sends.map((m) => m.at))) / 60000;
  console.log(`latency samples (turn moves + plain sends): ${sends.length} over ${span2.toFixed(1)} min, ${run.filter((r) => r.type === "ping" && r.err).length} pings with an error`);
  console.log("send -> account update over the subscription:", fmt(summarize(sends.filter((m) => m.subAt).map((m) => m.subAt - m.marks.send0))));
  console.log("send -> signature confirmed (poll):          ", fmt(summarize(sends.map((m) => m.marks.poll - m.marks.send0))));
  console.log("send request itself (RPC accepted it):       ", fmt(summarize(sends.map((m) => m.marks.sent - m.marks.send0))));
  console.log("whole app path (blockhash, sign, send, poll):", fmt(summarize(sends.map((m) => m.marks.poll - m.marks.start))));
  console.log("subscription missed:", sends.filter((m) => !m.subAt).length);

  const clocks = run.filter((r) => r.type === "clock");
  if (clocks.length) {
    const steps = new Set(clocks.flatMap((c) => c.steps));
    const readings = clocks.reduce((a, c) => a + c.readings, 0);
    const changes = clocks.reduce((a, c) => a + c.changes, 0);
    const b = clocks.map((c) => c.boundaryMs as number);
    const t = clocks.map((c) => (c.at - clocks[0].at) / 60000);
    const slope = b.length > 1 ? regress(t, b) : NaN;
    console.log(
      `rollup clock: steps seen ${[...steps].join(",")} s; ${changes} changes in ${readings} readings (a change about every ${(readings / Math.max(1, changes)).toFixed(1)} readings); ` +
        `second boundary vs local clock min ${Math.min(...b).toFixed(0)} / median ${percentile(b, 50).toFixed(0)} / max ${Math.max(...b).toFixed(0)} ms; drift ${slope.toFixed(2)} ms/min over ${t[t.length - 1].toFixed(0)} min; one-way ${percentile(clocks.map((c) => c.oneWayMs), 50).toFixed(0)} ms`,
    );
  }

  const turns = ok.filter((m) => landed.get(m.sig)?.blockTime);
  const ts = turns.map((m) => [m.turnTs as number, landed.get(m.sig)!.blockTime as number] as const);
  console.log(`late-move rate (move sent 4.5 s after the turn showed on screen; clock of its block vs turn start + ${TURN_SECS} s + grace), ${ts.length} moves with a block time:`);
  for (const g of [0, 1, 2, 3]) {
    const { late, of } = lateRate(ts.map(([turnTs, landedTs]) => ({ turnTs, landedTs })), TURN_SECS, g);
    console.log(`  grace ${g} s: ${late}/${of} late (${((100 * late) / Math.max(1, of)).toFixed(1)}%)`);
  }
  // Continuous, worst phase: the program floors the turn start to a whole second, so the real window after the true start is
  // between 5 + grace and 6 + grace seconds. Take the short end, and count the screen seeing the turn one sub delay late.
  const owd = percentile(clocks.map((c) => c.oneWayMs), 50);
  for (const g of [0, 1]) {
    const room = ok.map((m) => (TURN_SECS + g) * 1000 - (m.marks.send0 + (m.marks.sent - m.marks.send0) / 2 - m.turnSeenMs) - owd);
    const s2 = summarize(room);
    console.log(
      `  worst-phase time left when the move ran, grace ${g} s: n=${s2.n} min ${s2.min.toFixed(0)} p1 ${percentile(room, 1).toFixed(0)} p50 ${s2.p50.toFixed(0)} ms (sent at ${(MOVE_AFTER / 1000).toFixed(1)} s on screen; the latest on-screen send that still lands is about ${((MOVE_AFTER + s2.min) / 1000).toFixed(2)} s)`,
    );
  }
  const slack = ts.map(([s, t]) => s + TURN_SECS + 1 - t);
  console.log("  slack against the deadline with 1 s grace (whole seconds left), histogram:", JSON.stringify(histogram(slack)));
}

// Race: the claim of one machine's peer against the moves of the other.
for (const run of runs) {
  const moves = run.filter((r) => r.type === "move" && !r.err);
  const other = runs.find((r) => r !== run);
  if (!other) continue;
  const claims = new Map<string, Rec>();
  for (const c of other.filter((r) => r.type === "claim")) claims.set(`${c.match}:${c.turnTs}`, c);
  let paired = 0;
  let late = 0;
  let validClaim = 0;
  let claimFirst = 0;
  let beaten = 0;
  let unordered = 0;
  const gaps: number[] = [];
  for (const m of moves) {
    const c = claims.get(`${m.match}:${m.turnTs}`);
    const lm = landed.get(m.sig);
    const lc = c && landed.get(c.sig);
    if (!c || !lm || !lc || !lm.blockTime || !lc.blockTime) continue;
    paired++;
    const deadline = m.turnTs + TURN_SECS + 1;
    const moveLate = lm.blockTime > deadline;
    const claimValid = lc.blockTime > deadline;
    const before = lc.slot !== lm.slot ? lc.slot < lm.slot : lc.index !== null && lm.index !== null ? lc.index < lm.index : null;
    if (before === null) unordered++;
    if (moveLate) late++;
    if (claimValid) validClaim++;
    if (before) claimFirst++;
    if (moveLate && claimValid && before) beaten++;
    gaps.push(lm.slot - lc.slot);
  }
  console.log(
    `\n## race: moves from ${label(run)} against claims sent from ${label(other)} aimed at deadline + 1 s: ${paired} paired turns; move late ${late}; claim valid when it ran ${validClaim}; claim ran first ${claimFirst}; ` +
      `move rejected AND claim already in (the forfeit case) ${beaten}; order unknown ${unordered}; slots between claim and move p50 ${percentile(gaps, 50)} (slots are about 10 ms)`,
  );
}

function regress(x: number[], y: number[]) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  const num = x.reduce((a, xi, i) => a + (xi - mx) * (y[i] - my), 0);
  const den = x.reduce((a, xi) => a + (xi - mx) ** 2, 0);
  return den === 0 ? NaN : num / den;
}
function histogram(v: number[]) {
  const h: Record<string, number> = {};
  for (const x of v) h[x] = (h[x] ?? 0) + 1;
  return h;
}
