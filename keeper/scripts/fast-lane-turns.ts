/**
 * How long one turn of the Block Burst fast lane takes on the real devnet, idle and busy. DRY-RUN: reads only, sends nothing
 * (every send goes through `act`, which only logs in dry-run), and it is a handful of turns, not a loop.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/fast-lane-turns.ts [turns=4]
 *
 * "busy" forces the jobs to run (a stand-in for a joined Match) so their reads are timed against the live tables.
 */
import { Connection } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { Budget, log, type Ctx } from "../src/act.ts";
import { loadPayer, settings } from "../src/env.ts";
import { historyJob } from "../src/history.ts";
import { FastLane } from "../src/lanes.ts";
import { matchHygiene, scanMatches } from "../src/matches.ts";
import { buildRuntime, clusterNow, fetchWithBackoff, newConnection } from "../src/runtime.ts";
import { burstAdapter, tablesJob } from "../src/scheduler-games.ts";

const turns = Number(process.argv[2] ?? 4);
const s = settings(["--dry-run"]);
const conn = newConnection(s.rpc, s.gpaRpc);
const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: fetchWithBackoff as typeof fetch }));
const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };

const lane = (busy: boolean) =>
  new FastLane({
    scan: async (c) => {
      const real = await scanMatches(c);
      return busy ? [...real, { address: payer.publicKey, stage: "active", inner: { game: Array.from(BLOCK_PUZZLE_PROGRAM_ID.toBytes()) } }] : real;
    },
    clock: (c) => clusterNow(c.conn),
    hotMs: 20_000,
    quietMs: 300_000,
    jobs: [["tables", (c) => tablesJob(c, [burstAdapter])], ["match", (c) => matchHygiene(c, BLOCK_PUZZLE_PROGRAM_ID)], ["history", historyJob]],
  });

for (const busy of [false, true]) {
  const l = lane(busy);
  const ms: number[] = [];
  for (let i = 0; i < turns; i++) {
    const t = Date.now();
    await l.turn(ctx, Date.now());
    ms.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${busy ? "busy" : "idle"} turns (ms): ${ms.join(", ")}  median ${[...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]}`);
}
process.exit(0);
