import { Budget, log, runJob, type Ctx } from "./act.ts";
import { alertsJob } from "./alerts-job.ts";
import { awayCleanup } from "./away.ts";
import { backingHygiene } from "./backing.ts";
import { batchesJob } from "./batches.ts";
import { bridgeJob } from "./bridge.ts";
import { cashInJob, harvestJob } from "./counters.ts";
import { historyJob } from "./history.ts";
import { orderJob } from "./orders.ts";
import { overflowJob } from "./overflow.ts";
import { poolJob } from "./pools.ts";
import { listingJob, sweepJob } from "./sweeps.ts";
import { ticketJob } from "./tickets.ts";
import { loadPayer, settings, shortKey } from "./env.ts";
import { Health, startHealthServer, startWatchdog } from "./health.ts";
import { matchHygiene } from "./matches.ts";
import { notifyJob } from "./notify.ts";
import { notifyEventsJob } from "./notify-events.ts";
import { priceJob, priceJobEnabled } from "./price.ts";
import { Connection } from "@solana/web3.js";
import { buildRuntime, clusterNow, fetchWithBackoff, newConnection, rateLimit } from "./runtime.ts";
import { seasonJob } from "./season.ts";
import { FastLane, nextTurn } from "./lanes.ts";
import { burstAdapter, tablesJob } from "./scheduler-games.ts";
import { scanMatches } from "./matches.ts";
import { treasuryJob } from "./treasury.ts";
import { sponsorCompletionJob } from "./sponsor-completion.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 5 * 60_000;
/** A pass is at most ~17 jobs x KEEPER_JOB_LIMIT_SECS plus a backoff sleep; no pass finished in this long means the loop is stuck. */
const WATCHDOG_MS = Number(process.env.KEEPER_WATCHDOG_SECS ?? 40 * 60) * 1000;

async function pass(ctx: Ctx, alerts: (c: Ctx) => Promise<number>) {
  ctx.now = await clusterNow(ctx.conn);
  ctx.budget.observe(await ctx.conn.getBalance(ctx.payer.publicKey));
  // Price first: Advances stop 24 h after the last set_price, so it must not wait behind slower jobs.
  const jobs: [string, (c: Ctx) => Promise<number>][] = [
    ...(priceJobEnabled() ? ([["price", priceJob]] as [string, (c: Ctx) => Promise<number>][]) : []),
    // Stake pools first: a payout out of a stake custody is refused from a pool that is behind.
    ["pools", poolJob],
    // The table scheduler runs on its own: commits, resets, assignments and table growth wait for no Match scan, and the Match job reuses its scan.
    ["tables", (c) => tablesJob(c)],
    ["match", matchHygiene],
    // After the Match job, so a settle that just started is in the records; before notify, which announces from them.
    ["history", historyJob],
    ["tickets", ticketJob],
    ["sponsor", sponsorCompletionJob],
    ["orders", orderJob],
    ["backing", backingHygiene],
    ["away", awayCleanup],
    ["bridge", bridgeJob],
    ["batches", batchesJob],
    ["treasury", treasuryJob],
    ["harvest", harvestJob],
    ["fees", cashInJob],
    ["season", seasonJob],
    // After the Match and Season jobs, which are what make records.
    ["overflow", overflowJob],
    ["sweep", sweepJob],
    ["listing", listingJob],
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
  const fastLane = new FastLane({
    scan: scanMatches,
    clock: (c) => clusterNow(c.conn),
    hotMs: 20_000,
    jobs: [["tables", (c) => tablesJob(c, [burstAdapter])], ["match", matchHygiene], ["history", historyJob]],
  });
  let delay = s.intervalMs;
  let fullAt = Date.now();
  let fastAt: number | null = null;
  do {
    // Between full passes the fast lane keeps Block Burst Matches moving; a rate-limited pass pauses it until the next full one.
    while (!s.once && nextTurn({ fullAt, fastAt }) === "fast") {
      await sleep(Math.max(0, fastAt! - Date.now()));
      rateLimit.hits = 0;
      try {
        await fastLane.turn(ctx);
      } catch (e) {
        log("keeper", "-", `ERROR fast lane: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
      }
      fastAt = rateLimit.hits > 0 ? null : Date.now() + s.fastMs;
    }
    await sleep(Math.max(0, fullAt - Date.now()));
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
    fullAt = Date.now() + delay;
    fastAt = s.fastMs > 0 && rateLimit.hits === 0 ? Date.now() + s.fastMs : null;
  } while (true);
  log("keeper", "-", `pass done, spent ${(ctx.budget.spentLastHour() / 1e9).toFixed(5)} SOL this hour`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
