/**
 * Read-only trace of the Block Burst fast lane on the real devnet: every RPC request of every turn with its duration, one
 * JSON line each, plus the keeper's own log lines. DRY-RUN (sends nothing). Run it beside `app/scripts/match-timing.mts` to
 * see where the seconds between a join landing and the table being assigned go.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/assign-trace.ts <out.jsonl> [seconds=120]
 */
import { appendFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "../src/act.ts";
import { loadPayer, settings } from "../src/env.ts";
import { historyJob } from "../src/history.ts";
import { FastLane } from "../src/lanes.ts";
import { matchHygiene, scanMatches } from "../src/matches.ts";
import { buildRuntime, clusterNow, fetchWithBackoff, newConnection } from "../src/runtime.ts";
import { burstAdapter, tablesJob } from "../src/scheduler-games.ts";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";

const out = process.argv[2];
const secs = Number(process.argv[3] ?? 120);
if (!out) throw new Error("usage: assign-trace.ts <out.jsonl> [seconds]");
const emit = (o: object) => appendFileSync(out, JSON.stringify(o) + "\n");

let turn = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, i?: any) => {
  const t = Date.now();
  let method = "?";
  try { method = JSON.parse(String(i?.body)).method; } catch {}
  const r = await realFetch(u, i);
  emit({ type: "rpc", turn, method, host: new URL(String(u)).host, t, ms: Date.now() - t });
  return r;
}) as typeof fetch;

const s = settings(["--dry-run"]);
const conn = newConnection(s.rpc, s.gpaRpc);
const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: fetchWithBackoff as typeof fetch }));
const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
const lane = new FastLane({
  scan: scanMatches,
  probe: async (c) => (await c.conn.getSignaturesForAddress(c.core.programId, { limit: 1 }, "confirmed"))[0]?.signature ?? null,
  idleScanMs: 60_000,
  clock: (c) => clusterNow(c.conn),
  hotMs: 20_000,
  quietMs: 300_000,
  jobs: [["tables", (c) => tablesJob(c, [burstAdapter])], ["match", (c) => matchHygiene(c, BLOCK_PUZZLE_PROGRAM_ID)], ["history", historyJob]],
});
const end = Date.now() + secs * 1000;
while (Date.now() < end) {
  turn++;
  const t = Date.now();
  let ran = -1;
  try { ran = await lane.turn(ctx, t); } catch (e) { emit({ type: "error", turn, e: String(e) }); }
  emit({ type: "turn", turn, t, ms: Date.now() - t, ran });
  await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - t))));
}
process.exit(0);
