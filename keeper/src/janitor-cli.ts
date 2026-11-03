import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { postAlert } from "./alerts.ts";
import { meter } from "./credits.ts";
import { loadPayer, settings } from "./env.ts";
import { janitor, PARTS, type PartName } from "./janitor.ts";
import { realJanitorDeps } from "./janitor-chain.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";

/**
 * The daily janitor, started by a systemd timer. Closes expired sponsored Tickets, old receipts, old pair counters and
 * spent Assignments, refreshes broken Listings and publishes the trailing APY (see janitor.ts), then exits: 0 when every
 * part ran, 1 when one failed (the unit shows as failed, which is what the alert watches).
 * `--dry-run` prints what it would do and sends nothing. `--only tickets,receipts` runs just those parts.
 */
async function main() {
  const s = settings();
  const only = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean);
  const bad = only.filter((p) => !(PARTS as readonly string[]).includes(p));
  if (bad.length) throw new Error(`unknown part(s) ${bad.join(",")}: ${PARTS.join(", ")}`);
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  const report = await meter.inJob("janitor", () => janitor(ctx, realJanitorDeps(ctx), only.length ? (only as PartName[]) : PARTS));
  for (const p of report.parts) log("janitor", p.name, `${p.error ? `ERROR ${p.error}` : `${p.actions} action(s)`}${p.note ? ` (${p.note})` : ""}`);
  const base = process.env.NOTIFY_URL;
  const secret = process.env.NOTIFY_SECRET;
  for (const a of report.alerts) {
    log("janitor", "-", `ALERT ${a.title}: ${a.detail}`);
    if (base && secret && !s.dryRun) await postAlert(base, secret, { kind: "alert", key: a.key, title: a.title, detail: a.detail, source: "janitor" });
  }
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  process.exit(report.parts.some((p) => p.error) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
