import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { meter } from "./credits.ts";
import { loadPayer, settings } from "./env.ts";
import { stateDir } from "./history.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";
import { fileStore, realSteps, seasonRun } from "./season-run.ts";

/**
 * The weekly Season run, started by a systemd timer (Monday 00:15 UTC, Wednesday 00:30 UTC, and hourly to retry).
 * Runs whichever steps are due and not yet done this week, then exits: 0 when everything due is done, 1 when a step
 * is left for the next retry (the unit shows as failed, which is what the alert watches).
 */
async function main() {
  const s = settings();
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  const store = fileStore(join(stateDir(), "season-run.json"));
  const report = await meter.inJob("season-run", () => seasonRun(ctx.now, realSteps(ctx, store), store));
  log("season-run", "-", `season=${report.season} done=[${report.done.join(",")}] ${report.stoppedAt ? `STOPPED at ${report.stoppedAt}` : "nothing left"}`);
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  process.exit(report.stoppedAt ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
