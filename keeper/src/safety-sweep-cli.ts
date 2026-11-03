import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { postAlert } from "./alerts.ts";
import { meter } from "./credits.ts";
import { loadPayer, settings } from "./env.ts";
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
async function main() {
  const s = settings();
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  const store = fileSweepStore(join(stateDir(), "safety-sweep.json"));
  const report = await meter.inJob("safety-sweep", () => safetySweep(realSweepDeps(ctx), store, { now: ctx.now, dryRun: s.dryRun }));
  for (const c of report.candidates) log("sweep", c.address.toBase58(), `${s.dryRun ? "DRY-RUN " : ""}candidate ${c.case}: ${c.action} (known ${c.ageSecs}s)`);
  for (const a of report.alerts) log("sweep", "-", `ALERT ${a}`);
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  if (base && secret && !s.dryRun) {
    for (const detail of report.newAlerts) await postAlert(base, secret, { kind: "alert", key: `sweep:${detail.split(" ")[0]}`, title: "Safety sweep: a Match is stuck", detail, source: "safety-sweep" });
  }
  log("sweep", "-", `scanned ${JSON.stringify(report.scanned)}: ${report.candidates.length} candidate(s), ${report.alerts.length} stuck`);
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  process.exit(report.alerts.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
