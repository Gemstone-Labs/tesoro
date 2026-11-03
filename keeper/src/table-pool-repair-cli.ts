import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { loadPayer, settings } from "./env.ts";
import { scanMatches } from "./matches.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";
import { repairPool } from "./scheduler.ts";
import { ADAPTERS } from "./scheduler-games.ts";
import { poolPublisherFromEnv } from "./table-pool.ts";

/**
 * Reads every Game's tables from the rollup and republishes the pool the sponsor server assigns from (see table-pool.ts),
 * then exits. Started by a systemd timer; the server keeps the pool between runs, so this only corrects drift.
 * `--dry-run` prints what it would publish and writes nothing.
 */
async function main() {
  const s = settings();
  const publish = poolPublisherFromEnv();
  if (!publish && !s.dryRun) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set: there is no pool to repair.");
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  const matches = await scanMatches(ctx);
  let failed = 0;
  for (const a of ADAPTERS) {
    try {
      const n = await repairPool(ctx, a, matches, async (game, tables, readAt) => {
        if (s.dryRun || !publish) return log("pool", a.label, `DRY-RUN would publish ${JSON.stringify(tables)}`);
        await publish(game, tables, readAt);
      });
      log("pool", a.label, n === null ? "skipped (no tables, or an Assignment could not be read)" : `${n} table(s) free`);
    } catch (e) {
      failed++;
      log("pool", a.label, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
