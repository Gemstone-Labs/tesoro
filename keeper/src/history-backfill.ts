import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { pooled, transactionRecords, type ScanConn } from "./events-scan.ts";
import type { Sink } from "./history.ts";

/** The CLI and tests use the same loop: a dry run reads and validates the complete range without invoking a writer. */
export async function backfillHistory(conn: ScanConn, sigs: ConfirmedSignatureInfo[], opts: {
  dryRun: boolean;
  sink: Sink | null;
  progress?: (handled: number, records: number) => void;
}): Promise<{ records: number; written: number }> {
  let records = 0, written = 0;
  const batchSize = 60;
  for (let i = 0; i < sigs.length; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const txs = await pooled(batch, 6, (sig) => transactionRecords(conn, sig));
    for (let j = 0; j < batch.length; j++) {
      const tx = txs[j];
      if (!tx) throw new Error(`transaction ${batch[j].signature} could not be read; run again`);
      records += tx.records.length;
      if (!opts.dryRun && opts.sink && tx.records.length) {
        await opts.sink(tx);
        written++;
      }
    }
    opts.progress?.(Math.min(i + batchSize, sigs.length), records);
  }
  return { records, written };
}
