import type { Rpc } from "../history/rpc";
import type { RawTx, StoredTx } from "../history/webhook";
import { processTx, type NotifyChain } from "./from-tx";
import type { OpenMatchStore } from "./open-match";
import { handleEvent, type NotifyDeps } from "./service";

/** Emails are not sent about transactions older than this: a late switch-on or a long outage does not replay the past. */
export const MAX_EMAIL_AGE_SECS = 3 * 24 * 3600;
/** How long a worker holds the transactions it took. */
const LEASE_SECS = 120;

/** Stored transactions whose emails are not sent yet (migration 0022). */
export interface NotifyTxStore {
  /** Takes up to `limit` finalized transactions, oldest first, and holds them for `leaseSecs`. */
  claim(limit: number, leaseSecs: number): Promise<StoredTx[]>;
  /** Ends the claim: `error` null marks the transaction done; otherwise it is offered again, and after five tries left for a person. */
  done(signature: string, error: string | null): Promise<void>;
}

export const rpcNotifyTxStore = (rpc: Rpc): NotifyTxStore => ({
  claim: async (limit, leaseSecs) =>
    ((await rpc("webhook_claim_notify", { p_limit: limit, p_lease_secs: leaseSecs })) as { signature: string; slot: number; blockTime: number | null; body: RawTx }[]).map((r) => ({
      signature: r.signature,
      slot: Number(r.slot),
      blockTime: r.blockTime == null ? null : Number(r.blockTime),
      body: r.body,
    })),
  done: async (signature, error) => void (await rpc("webhook_notify_done", { p_signature: signature, p_error: error })),
});

export interface PendingDeps {
  txs: NotifyTxStore;
  matches: OpenMatchStore;
  chain: NotifyChain;
  /** Null when this server cannot send email: the open-Match table is still kept up to date. */
  notify: NotifyDeps | null;
  /** Milliseconds, like NotifyDeps.now. */
  now?: () => number;
  limit?: number;
  warn?: (message: string) => void;
}

/**
 * Reads the finalized transactions the webhook stored, keeps the open-Match table up to date and emails the Players the
 * transactions concern. Each email kind is sent once per event (the notify store claims the event id), so a transaction read
 * twice, delivered twice or retried after a failed send never mails twice. A transaction that fails is offered again.
 */
export async function notifyPending(deps: PendingDeps): Promise<{ processed: number; failed: number }> {
  const nowSecs = Math.floor((deps.now ?? Date.now)() / 1000);
  let processed = 0;
  let failed = 0;
  for (const row of await deps.txs.claim(deps.limit ?? 100, LEASE_SECS)) {
    try {
      const fresh = row.blockTime === null || nowSecs - row.blockTime <= MAX_EMAIL_AGE_SECS;
      const events = await processTx(row.body, deps, { emails: !!deps.notify && fresh });
      for (const event of events) await handleEvent(deps.notify!, event);
      await deps.txs.done(row.signature, null);
      processed++;
    } catch (e) {
      const message = String((e as Error).message ?? e).split("\n")[0].slice(0, 300);
      deps.warn?.(`notify transaction ${row.signature.slice(0, 8)} failed: ${message}`);
      await deps.txs.done(row.signature, message);
      failed++;
    }
  }
  return { processed, failed };
}
