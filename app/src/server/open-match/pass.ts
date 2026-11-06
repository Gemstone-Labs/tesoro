import type { Rpc } from "../history/rpc";
import type { RawTx, StoredTx } from "../history/webhook";
import type { OpenMatchStore } from "./store";
import { trackTx } from "./track";

/** How long a worker holds the transactions it took. */
const LEASE_SECS = 120;

/** Stored transactions whose open-Match tracking is not done yet (migration 0022: the `notify_*` columns and functions keep their old names). */
export interface TrackTxStore {
  /** Takes up to `limit` finalized transactions, oldest first, and holds them for `leaseSecs`. */
  claim(limit: number, leaseSecs: number): Promise<StoredTx[]>;
  /** Ends the claim: `error` null marks the transaction done; otherwise it is offered again, and after five tries left for a person. */
  done(signature: string, error: string | null): Promise<void>;
}

export const rpcTrackTxStore = (rpc: Rpc): TrackTxStore => ({
  claim: async (limit, leaseSecs) =>
    ((await rpc("webhook_claim_notify", { p_limit: limit, p_lease_secs: leaseSecs })) as { signature: string; slot: number; blockTime: number | null; body: RawTx }[]).map((r) => ({
      signature: r.signature,
      slot: Number(r.slot),
      blockTime: r.blockTime == null ? null : Number(r.blockTime),
      body: r.body,
    })),
  done: async (signature, error) => void (await rpc("webhook_notify_done", { p_signature: signature, p_error: error })),
});

export interface TrackDeps {
  txs: TrackTxStore;
  matches: OpenMatchStore;
  limit?: number;
  warn?: (message: string) => void;
}

/**
 * Reads the finalized transactions the webhook stored and keeps the open-Match table up to date (the keeper's safety sweep
 * reads it). A transaction that fails is offered again, and after five tries left for a person. Nobody is mailed.
 */
export async function trackPending(deps: TrackDeps): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (const row of await deps.txs.claim(deps.limit ?? 100, LEASE_SECS)) {
    try {
      await trackTx(row.body, deps.matches);
      await deps.txs.done(row.signature, null);
      processed++;
    } catch (e) {
      const message = String((e as Error).message ?? e).split("\n")[0].slice(0, 300);
      deps.warn?.(`open-Match tracking of ${row.signature.slice(0, 8)} failed: ${message}`);
      await deps.txs.done(row.signature, message);
      failed++;
    }
  }
  return { processed, failed };
}

/** Drops closed and long-expired rows from the open-Match table. */
export async function pruneOpenMatches(matches: OpenMatchStore, nowMs: number = Date.now()): Promise<number> {
  return matches.prune(Math.floor(nowMs / 1000));
}
