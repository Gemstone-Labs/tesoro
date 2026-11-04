import { Budget, log, runJobs, type Ctx } from "./act.ts";
import { heartbeatFrom, HEARTBEAT_ENV } from "./heartbeat.ts";
import { keeperCluster } from "./cluster.ts";
import { loadPayer, settings, shortKey } from "./env.ts";
import { Health, startHealthServer, startWatchdog } from "./health.ts";
import { priceJob, priceJobEnabled } from "./price.ts";
import { Connection } from "@solana/web3.js";
import { buildRuntime, clusterNow, newConnection, rateLimit, solanaFetch } from "./runtime.ts";
import { meter } from "./credits.ts";

/**
 * The devnet extras loop (keeper-diet ADR 0012). Everything else the keeper used to do in this loop is a Player transaction
 * or a scheduled run: Season run, safety sweep, janitor, table-pool repair (systemd timers under keeper/deploy) and the
 * admin scripts (admin-cli). What is left here is what test mode needs and no Player transaction can carry: the Advance
 * price, written by the keeper only while the cluster's price source is "keeper". On mainnet the price comes from Pyth, so
 * there is nothing to loop on and this process exits at once.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 5 * 60_000;
const WATCHDOG_MS = Number(process.env.KEEPER_WATCHDOG_SECS ?? 40 * 60) * 1000;

/** The jobs of one pass on this cluster. */
const devnetJobs = (): [string, (c: Ctx) => Promise<number>][] => (priceJobEnabled() ? [["price", priceJob]] : []);

async function pass(ctx: Ctx) {
  ctx.now = await clusterNow(ctx.conn);
  ctx.budget.observe(await ctx.conn.getBalance(ctx.payer.publicKey));
  await runJobs(devnetJobs(), ctx);
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  meter.reset();
}

async function main() {
  if (!priceJobEnabled()) {
    log("keeper", "-", `nothing to loop on cluster ${keeperCluster().id}: Season run, safety sweep, janitor and table-pool repair are timers (keeper/deploy)`);
    return;
  }
  const s = settings();
  const hostOf = (u: string) => new URL(u).host;
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  const balance = await conn.getBalance(payer.publicKey);
  log("keeper", "-", `start devnet extras rpc=${hostOf(s.rpc)} payer=${shortKey(payer.publicKey)} balance=${(balance / 1e9).toFixed(3)} SOL cap=${(s.hourlyCapLamports / 1e9).toFixed(2)} SOL/h ${s.once ? "once" : `every ${s.intervalMs / 1000}s`}${s.dryRun ? " DRY-RUN" : ""}`);

  const health = new Health(WATCHDOG_MS);
  if (!s.once) {
    startWatchdog(health, (m) => log("keeper", "-", m));
    if (process.env.KEEPER_HEALTH_PORT) startHealthServer(health, Number(process.env.KEEPER_HEALTH_PORT), (m) => log("keeper", "-", m), process.env.KEEPER_HEALTH_HOST || undefined);
  }
  const heartbeat = heartbeatFrom(HEARTBEAT_ENV.loop, process.env, fetch, (m) => log("keeper", "-", m));
  let delay = s.intervalMs;
  do {
    rateLimit.hits = 0;
    const started = Date.now();
    let ok = true;
    try {
      await pass(ctx);
    } catch (e) {
      if (s.once) throw e;
      ok = false;
      log("keeper", "-", `ERROR pass failed, retrying next interval: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    if (s.once) break;
    health.beat(ok);
    await heartbeat.ping(ok ? "ok" : "fail");
    log("keeper", "-", `alive pass=${health.passes} took=${((Date.now() - started) / 1000).toFixed(1)}s${ok ? "" : ` failed-in-a-row=${health.failedInARow}`} spent=${(ctx.budget.spentLastHour() / 1e9).toFixed(5)} SOL/h`);
    // Back off on 429s (doubling, capped); recover to the base interval on a clean pass.
    delay = rateLimit.hits > 0 ? Math.min(delay * 2, MAX_BACKOFF_MS) : s.intervalMs;
    if (rateLimit.hits > 0) log("keeper", "-", `rate limited ${rateLimit.hits}x, next pass in ${delay / 1000}s`);
    await sleep(delay);
  } while (true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
