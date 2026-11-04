import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { AlertManager, alertConfig, postAlert } from "./alerts.ts";
import { balanceCheck, fileBalanceStore, sponsorMinLamports, sponsorWatches } from "./balance-check.ts";
import { keeperCluster } from "./cluster.ts";
import { heartbeatFrom, HEARTBEAT_ENV } from "./heartbeat.ts";
import { stateDir } from "./history.ts";
import { join } from "node:path";
import { KEEPER_CLI_FLAGS, exitOnUnknownFlag } from "./cli-args.ts";
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
const USAGE = "Usage: table-pool-repair-cli [--dry-run] [--rpc <url>] [--gpa-rpc <url>]\n  --dry-run  print what would be published, write nothing";

async function main() {
  exitOnUnknownFlag(process.argv.slice(2), KEEPER_CLI_FLAGS, USAGE);
  const heartbeat = heartbeatFrom(HEARTBEAT_ENV.pool);
  const s = settings();
  try {
    await run(s, heartbeat);
  } catch (e) {
    if (!s.dryRun) await heartbeat.ping("fail");
    throw e;
  }
}

async function run(s: ReturnType<typeof settings>, heartbeat: ReturnType<typeof heartbeatFrom>) {
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
  if (!s.dryRun) await sponsorBalances(ctx);
  if (!s.dryRun) await heartbeat.ping(failed ? "fail" : "ok");
  process.exit(failed ? 1 : 0);
}

/** Every run: each Game's Sponsor, read on the rollup. A Sponsor that runs dry blocks Matches from ending. A failure here never fails the run. */
async function sponsorBalances(ctx: Ctx) {
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!base || !secret) return;
  try {
    const cfg = alertConfig();
    const byKey = new Map(ADAPTERS.map((a) => [`${a.label} Sponsor`, a]));
    const store = fileBalanceStore(join(stateDir(), "sponsor-balance.json"));
    const r = await balanceCheck({
      now: Date.now(),
      everyMs: 0,
      ...store,
      watches: sponsorWatches(ADAPTERS.map((a) => ({ label: a.label, address: a.sponsorAddress().toBase58() })), sponsorMinLamports()),
      read: async (w) => {
        const lamports = await byKey.get(w.label)!.sponsorBalance(ctx);
        return lamports === null ? Number.NaN : lamports / 1e9;
      },
      manager: (st) => new AlertManager((a) => postAlert(base, secret, a), cfg.reminderMs, keeperCluster().id).restore(st),
    });
    log("pool", "-", `sponsors checked, ${r.low} low`);
  } catch (e) {
    log("pool", "-", `ERROR sponsor check ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
