import { Budget, log, runJob, type Ctx } from "./act.ts";
import { alertsJob } from "./alerts-job.ts";
import { awayCleanup } from "./away.ts";
import { backingHygiene } from "./backing.ts";
import { bridgeJob } from "./bridge.ts";
import { loadPayer, settings, shortKey } from "./env.ts";
import { Health, startHealthServer, startWatchdog } from "./health.ts";
import { matchHygiene } from "./matches.ts";
import { notifyJob } from "./notify.ts";
import { notifyEventsJob } from "./notify-events.ts";
import { priceJob, priceJobEnabled } from "./price.ts";
import { Connection } from "@solana/web3.js";
import { buildRuntime, clusterNow, fetchWithBackoff, newConnection, rateLimit } from "./runtime.ts";
import { seasonJob } from "./season.ts";
import { treasuryJob } from "./treasury.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 5 * 60_000;
/** A pass is at most ~6 jobs x KEEPER_JOB_LIMIT_SECS plus a backoff sleep; no pass finished in this long means the loop is stuck. */
const WATCHDOG_MS = Number(process.env.KEEPER_WATCHDOG_SECS ?? 20 * 60) * 1000;

async function pass(ctx: Ctx, alerts: (c: Ctx) => Promise<number>) {
  ctx.now = await clusterNow(ctx.conn);
  ctx.budget.observe(await ctx.conn.getBalance(ctx.payer.publicKey));
  // Price first: Advances stop 24 h after the last set_price, so it must not wait behind slower jobs.
  const jobs: [string, (c: Ctx) => Promise<number>][] = [
    ...(priceJobEnabled() ? ([["price", priceJob]] as [string, (c: Ctx) => Promise<number>][]) : []),
    ["match", matchHygiene],
    ["backing", backingHygiene],
    ["away", awayCleanup],
    ["bridge", bridgeJob],
    ["treasury", treasuryJob],
    ["season", seasonJob],
    ["notify", notifyJob],
    ["notify-events", notifyEventsJob],
  ];
  for (const [name, job] of jobs) await runJob(name, job, ctx);
  // Last, so the alerts see this pass's outcomes.
  await runJob("alerts", alerts, ctx);
}

async function main() {
  const s = settings();
  const hostOf = (u: string) => new URL(u).host;
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: fetchWithBackoff as typeof fetch }));
  const ctx: Ctx = {
    ...buildRuntime(s, conn, payer),
    budget: new Budget(s.hourlyCapLamports),
    lz: new Budget(s.lzHourlyCapLamports),
  };
  const balance = await conn.getBalance(payer.publicKey);
  log("keeper", "-", `start cluster=devnet rpc=${hostOf(s.rpc)} gpa=${hostOf(s.gpaRpc)} payer=${shortKey(payer.publicKey)} balance=${(balance / 1e9).toFixed(3)} SOL cap=${(s.hourlyCapLamports / 1e9).toFixed(2)} SOL/h ${s.once ? "once" : `every ${s.intervalMs / 1000}s`}${s.dryRun ? " DRY-RUN" : ""}`);

  const health = new Health(WATCHDOG_MS);
  if (!s.once) {
    startWatchdog(health, (m) => log("keeper", "-", m));
    if (process.env.KEEPER_HEALTH_PORT) startHealthServer(health, Number(process.env.KEEPER_HEALTH_PORT), (m) => log("keeper", "-", m), process.env.KEEPER_HEALTH_HOST || undefined);
  }

  const alerts = alertsJob(health);
  let delay = s.intervalMs;
  do {
    rateLimit.hits = 0;
    const started = Date.now();
    let ok = true;
    try {
      await pass(ctx, s.once ? async () => 0 : alerts);
    } catch (e) {
      // A dropped connection before any job ran (cluster time, balance) must not end the loop.
      if (s.once) throw e;
      ok = false;
      log("keeper", "-", `ERROR pass failed, retrying next interval: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    if (s.once) break;
    health.beat(ok);
    log("keeper", "-", `alive pass=${health.passes} took=${((Date.now() - started) / 1000).toFixed(1)}s${ok ? "" : ` failed-in-a-row=${health.failedInARow}`} spent=${(ctx.budget.spentLastHour() / 1e9).toFixed(5)} SOL/h`);
    // Back off on 429s (doubling, capped); recover to the base interval on a clean pass.
    delay = rateLimit.hits > 0 ? Math.min(delay * 2, MAX_BACKOFF_MS) : s.intervalMs;
    if (rateLimit.hits > 0) log("keeper", "-", `rate limited ${rateLimit.hits}x, next pass in ${delay / 1000}s`);
    await sleep(delay);
  } while (true);
  log("keeper", "-", `pass done, spent ${(ctx.budget.spentLastHour() / 1e9).toFixed(5)} SOL this hour`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
