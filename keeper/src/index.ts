import { Budget, log, type Ctx } from "./act.ts";
import { backingHygiene } from "./backing.ts";
import { bridgeJob } from "./bridge.ts";
import { ethYieldJob } from "./eth.ts";
import { loadPayer, settings, shortKey } from "./env.ts";
import { matchHygiene } from "./matches.ts";
import { priceJob } from "./price.ts";
import { buildRuntime, clusterNow, newConnection, rateLimit } from "./runtime.ts";
import { yieldJob } from "./yield.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 5 * 60_000;

async function pass(ctx: Ctx) {
  ctx.now = await clusterNow(ctx.conn);
  ctx.budget.observe(await ctx.conn.getBalance(ctx.payer.publicKey));
  const jobs: [string, (c: Ctx) => Promise<number>][] = [
    ["match", matchHygiene],
    ["backing", backingHygiene],
    ["price", priceJob],
    ["yield", yieldJob],
    ["bridge", bridgeJob],
    ["eth", ethYieldJob],
  ];
  for (const [name, job] of jobs) {
    try {
      await job(ctx);
    } catch (e) {
      log(name, "-", `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    }
  }
}

async function main() {
  const s = settings();
  const conn = newConnection(s.rpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m));
  const ctx: Ctx = {
    ...buildRuntime(s, conn, payer),
    budget: new Budget(s.hourlyCapLamports),
    lz: new Budget(s.lzHourlyCapLamports),
    eth: new Budget(Math.round(s.ethHourlyCapEth * 1e9)),
  };
  const balance = await conn.getBalance(payer.publicKey);
  log("keeper", "-", `start rpc=${s.rpc} payer=${shortKey(payer.publicKey)} balance=${(balance / 1e9).toFixed(3)} SOL cap=${(s.hourlyCapLamports / 1e9).toFixed(2)} SOL/h ${s.once ? "once" : `every ${s.intervalMs / 1000}s`}${s.dryRun ? " DRY-RUN" : ""}`);

  let delay = s.intervalMs;
  do {
    rateLimit.hits = 0;
    await pass(ctx);
    if (s.once) break;
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
