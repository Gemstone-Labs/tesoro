import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { postAlert } from "./alerts.ts";
import { meter } from "./credits.ts";
import { KEEPER_CLI_FLAGS, exitOnUnknownFlag } from "./cli-args.ts";
import { loadPayer, settings } from "./env.ts";
import { stateDir } from "./history.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";
import { fileStore, memoryStore, realSteps, seasonRun } from "./season-run.ts";

/**
 * The weekly Season run, started by a systemd timer (Monday 00:15 UTC, Wednesday 00:30 UTC, and hourly to retry).
 * Runs whichever steps are due and not yet done this week, then exits: 0 when everything due is done, 1 when a step
 * is left for the next retry (the unit shows as failed, which is what the alert watches).
 */
const USAGE = "Usage: season-run-cli [--dry-run] [--once] [--rpc <url>] [--gpa-rpc <url>]\n  --dry-run  build and simulate every step, send and save nothing; print the plan and the credit meter";

async function main() {
  exitOnUnknownFlag(process.argv.slice(2), KEEPER_CLI_FLAGS, USAGE);
  const s = settings();
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  // A dry run keeps its state in memory (nothing saved, so the real run still does every step) and makes one pass per step.
  const store = s.dryRun ? memoryStore() : fileStore(join(stateDir(), "season-run.json"));
  const report = await meter.inJob("season-run", () => seasonRun(ctx.now, realSteps(ctx, store), store, s.dryRun ? 1 : undefined));
  log("season-run", "-", `${s.dryRun ? "DRY-RUN " : ""}season=${report.season} done=[${report.done.join(",")}] ${report.stoppedAt ? `STOPPED at ${report.stoppedAt}` : "nothing left"}`);
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  for (const k of report.skipped) {
    log("season-run", k.step, `ALERT source=${k.source} skipped`);
    if (base && secret && !s.dryRun) await postAlert(base, secret, { kind: "alert", key: `season-run:${k.step}:${k.source}`, title: "Season run: a Source was skipped", detail: `${k.step} could not act on source=${k.source}; its share rolls into the next Season`, source: "season-run" });
  }
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  process.exit(report.stoppedAt ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
