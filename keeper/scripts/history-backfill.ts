/**
 * Rebuilds the Match history from core's events: reads every transaction that emitted a record, oldest first, and
 * writes the records with the same idempotent writer the keeper's history job uses. Safe to run any number of times,
 * at any time, next to the live keeper: a record is stored once however often it is read.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/history-backfill.ts [--rpc <url>] [--from <unix seconds>] \
 *     [--max-pages 200] [--set-cursor] [--dry-run]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (migration 0007 applied there). `--set-cursor` writes the newest
 * signature to the keeper's cursor file when the whole range was written, so the live job starts from there.
 * `--dry-run` only counts the transactions and records.
 */
import { join } from "node:path";
import { loadAppEnv } from "../src/env.ts";
import { parseArgs } from "../src/cli-args.ts";
import { collectSignatures, pooled, transactionRecords } from "../src/events-scan.ts";
import { databaseSink, fileCursor, historyRpc, stateDir } from "../src/history.ts";
import { newConnection } from "../src/runtime.ts";
import { settings } from "../src/env.ts";

loadAppEnv();
const a = parseArgs(process.argv.slice(2), ["dry-run", "set-cursor"]);
const s = settings(process.argv.slice(2));
const conn = newConnection(s.rpc, s.gpaRpc);
const from = a.value("from") ? Number(a.value("from")) : undefined;
const dryRun = a.flag("dry-run");
const rpc = historyRpc();
if (!dryRun && !rpc) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set (or use --dry-run)");
const sink = rpc ? databaseSink(rpc) : null;

const sigs = (await collectSignatures(conn, { olderThan: from, maxPages: Number(a.value("max-pages") ?? 200) })).reverse();
console.log(`${sigs.length} transaction(s) touched core's event authority${from ? ` since ${new Date(from * 1000).toISOString()}` : ""}`);

let records = 0;
let written = 0;
const BATCH = 60;
for (let i = 0; i < sigs.length; i += BATCH) {
  const batch = sigs.slice(i, i + BATCH);
  const txs = await pooled(batch, 6, (sig) => transactionRecords(conn, sig));
  for (let j = 0; j < batch.length; j++) {
    const tx = txs[j];
    if (!tx) throw new Error(`transaction ${batch[j].signature} could not be read; run again`);
    records += tx.records.length;
    if (sink && tx.records.length) {
      await sink(tx);
      written++;
    }
  }
  console.log(`${Math.min(i + BATCH, sigs.length)}/${sigs.length} transactions, ${records} records`);
}
console.log(`${dryRun ? "would write" : "wrote"} ${records} record(s) from ${dryRun ? sigs.length : written} transaction(s)`);
if (!dryRun && a.flag("set-cursor") && sigs.length) {
  const path = join(stateDir(), "history-cursor.json");
  fileCursor(path).save(sigs[sigs.length - 1].signature);
  console.log(`cursor ${sigs[sigs.length - 1].signature} saved to ${path}`);
}
