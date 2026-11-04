import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { AlertManager, alertConfig, postAlert } from "./alerts.ts";
import { balanceOf, watches } from "./alerts-job.ts";
import { balanceCheck, extraWatches, fileBalanceStore } from "./balance-check.ts";
import { keeperCluster } from "./cluster.ts";
import { heartbeatFrom, type Heartbeat, HEARTBEAT_ENV } from "./heartbeat.ts";
import { meter } from "./credits.ts";
import { KEEPER_CLI_FLAGS, exitOnUnknownFlag } from "./cli-args.ts";
import { loadPayer, settings } from "./env.ts";
import { webhookCatchUpJob } from "./webhook-history.ts";
import { stateDir } from "./history.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";
import { fileSweepStore, safetySweep } from "./safety-sweep.ts";
import { realSweepDeps } from "./safety-sweep-chain.ts";

/**
 * The safety sweep, started by a systemd timer every 5 minutes. Reads the Matches, sends the steps a Player who left would
 * have sent (see safety-sweep.ts), then exits: 0 when no Match is stuck, 1 while one is (the unit shows as failed, which
 * is what the alert watches; a new stuck Match is also mailed when NOTIFY_URL and NOTIFY_SECRET are set).
 * `--once` is accepted and implied. `--dry-run` prints the candidates and the credits and sends and saves nothing.
 */
const USAGE = "Usage: safety-sweep-cli [--dry-run] [--once] [--full] [--rpc <url>] [--gpa-rpc <url>]\n  --dry-run  print the candidates and the credit meter, send and save nothing\n  --full     scan the chain now instead of reading the database's candidates (otherwise done once an hour)";

async function main() {
  exitOnUnknownFlag(process.argv.slice(2), { ...KEEPER_CLI_FLAGS, bare: [...KEEPER_CLI_FLAGS.bare, "full"] }, USAGE);
  // The sweep has its own monitor (SWEEP_HEARTBEAT_URL); KEEPER_HEARTBEAT_URL belongs to the main loop alone.
  const heartbeat = heartbeatFrom(HEARTBEAT_ENV.sweep);
  try {
    await run(heartbeat);
  } catch (e) {
    if (!settings().dryRun) await heartbeat.ping("fail");
    throw e;
  }
}

async function run(heartbeat: Heartbeat) {
  const s = settings();
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  const store = fileSweepStore(join(stateDir(), "safety-sweep.json"));
  const report = await meter.inJob("safety-sweep", () => safetySweep(realSweepDeps(ctx), store, { now: ctx.now, dryRun: s.dryRun, full: process.argv.includes("--full") }));
  for (const c of report.candidates) log("sweep", c.address.toBase58(), `${s.dryRun ? "DRY-RUN " : ""}candidate ${c.case}: ${c.action} (known ${c.ageSecs}s)`);
  for (const a of report.alerts) log("sweep", "-", `ALERT ${a}`);
  for (const m of report.dbMisses) log("sweep", m, "ALERT the full scan found a Match the database did not know (a dropped webhook delivery?)");
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (base && secret && !s.dryRun) {
    for (const m of report.dbMisses) await postAlert(base, secret, { kind: "alert", key: `sweep-db-miss:${m}`, title: "Safety sweep: the database missed a Match", detail: `${m} needs the sweep but open_match did not know it (a dropped webhook delivery?)`, source: "safety-sweep" });
    for (const detail of report.newAlerts) await postAlert(base, secret, { kind: "alert", key: `sweep:${detail.split(" ")[0]}`, title: "Safety sweep: a Match is stuck", detail, source: "safety-sweep" });
  }
  if (!s.dryRun) await hourlyBalances(ctx);
  // The Helius webhook stores transactions at confirmed; this marks them finalized and decodes them into the history tables. Off unless KEEPER_WEBHOOK_HISTORY=1.
  if (!s.dryRun) await webhookCatchUpJob(ctx).catch((e) => log("webhook", "-", `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`));
  log("sweep", "-", `${report.mode} run, read ${JSON.stringify(report.scanned)}: ${report.candidates.length} candidate(s), ${report.alerts.length} stuck`);
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  // The sweep ran: a stuck Match is mailed above and shows as a failed unit, not as a dead keeper.
  if (!s.dryRun) await heartbeat.ping("ok");
  process.exit(report.alerts.length ? 1 : 0);
}

/** Hourly: keeper, oracle and relayer balances plus any ALERT_EXTRA_SOL accounts. A failure here never fails the sweep. */
async function hourlyBalances(ctx: Ctx) {
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (!base || !secret) return;
  try {
    const cfg = alertConfig();
    const store = fileBalanceStore(join(stateDir(), "balance-check.json"));
    const r = await balanceCheck({
      now: Date.now(),
      ...store,
      watches: [...watches(ctx, cfg), ...extraWatches()],
      read: (w) => balanceOf(ctx, w),
      manager: (st) => new AlertManager((a) => postAlert(base, secret, a), cfg.reminderMs, keeperCluster().id).restore(st),
    });
    if (r.ran) log("balances", "-", `checked, ${r.low} low`);
  } catch (e) {
    log("balances", "-", `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
