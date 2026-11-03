import { timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../lib/chain/games";
import { decodeMatchRecords, type InnerInstruction, type MatchRecord } from "./events";
import { ingestMatchRecords } from "./ingest";
import type { Rpc } from "./rpc";

/**
 * Match history from a Helius raw webhook on tesoro_core.
 *
 * ASSUMED, to check against the first real delivery (no Helius key was available when this was written; the shape is the
 * Raw webhook example of the Helius docs plus real `getTransaction` responses with `encoding: "json"`, see fixtures):
 *  1. The body is a JSON array of `{ blockTime, indexWithinBlock, meta, slot, transaction }` (one object is accepted too).
 *  2. `transaction.signatures[0]` is the signature; `transaction.message.accountKeys` is a list of base58 strings.
 *  3. `meta.innerInstructions[].instructions[]` carries `{ programIdIndex, accounts: number[], data: base58 }`, and for a v0
 *     transaction `meta.loadedAddresses.{writable,readonly}` lists the table-resolved keys (as `getTransaction` does).
 *  4. The `Authorization` header holds the secret configured as the webhook's authHeader (a leading "Bearer " is ignored).
 *  5. Delivery is at `confirmed`, not `finalized`, unless HELIUS_WEBHOOK_FINALIZED=1: a delivered row is then marked
 *     finalized by the catch-up scan, never by the webhook.
 */

export interface RawTx {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    innerInstructions?: { index?: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; addressTableLookups?: unknown[]; instructions?: { programIdIndex: number; accounts: number[]; data: string }[] } };
}

/** A stored transaction, as the history decoder needs it. */
export interface StoredTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  body: RawTx;
}

/** Plain storage of delivered transactions. Ticket 13 (e-mails) reads the same rows. */
export interface WebhookStore {
  /** False when the signature was stored before. `finalized` on a repeat still marks the stored row finalized. */
  put(tx: StoredTx & { finalized: boolean }): Promise<boolean>;
  /** Finalized rows not decoded yet, oldest first. */
  toDecode(limit: number): Promise<StoredTx[]>;
  /** `error` null: decoded. Otherwise the row is left for a person (it is not offered again until the error is cleared). */
  markDecoded(signature: string, error: string | null): Promise<void>;
  unfinalized(limit: number): Promise<string[]>;
  markFinalized(signatures: string[]): Promise<number>;
  cursor(): Promise<string | null>;
  setCursor(signature: string): Promise<void>;
}

export class WebhookHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const isRawTx = (x: unknown): x is RawTx => {
  const t = x as RawTx | null;
  return !!t && typeof t === "object" && typeof t.slot === "number" && !!t.transaction?.message && Array.isArray(t.transaction.signatures) && typeof t.transaction.signatures[0] === "string" && Array.isArray(t.transaction.message.accountKeys);
};

/** The transactions of a webhook body; items that do not have the expected shape are returned as `invalid`. */
export function parseWebhookBody(body: unknown): { txs: RawTx[]; invalid: number } {
  const items = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : null;
  if (!items) throw new WebhookHttpError(400, "bad-request", "Malformed webhook body.");
  const txs = items.filter(isRawTx);
  return { txs, invalid: items.length - txs.length };
}

export const signatureOf = (tx: RawTx) => tx.transaction.signatures[0];

/** What is kept: enough to decode and to read accounts later, without logs and balances. */
export function slim(tx: RawTx): RawTx {
  const m = tx.transaction.message;
  return {
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    meta: tx.meta && {
      err: tx.meta.err ?? null,
      innerInstructions: tx.meta.innerInstructions ?? [],
      loadedAddresses: tx.meta.loadedAddresses ?? { writable: [], readonly: [] },
    },
    transaction: { signatures: tx.transaction.signatures, message: { accountKeys: m.accountKeys, addressTableLookups: m.addressTableLookups ?? [], instructions: m.instructions ?? [] } },
  };
}

/** The inner instructions of a stored transaction (none for a failed one). Throws when one names an account the transaction does not list. */
export function innerOfRawTx(tx: RawTx): InnerInstruction[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  return (tx.meta.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((i) => {
      const programId = keys[i.programIdIndex];
      if (!programId) throw new Error(`inner instruction names account index ${i.programIdIndex}, which the transaction does not list`);
      return { programId, accounts: i.accounts.map((a) => keys[a]), data: bs58.decode(i.data) };
    }),
  );
}

/** The Match records of a stored transaction (none for a failed one). Throws when its inner instructions cannot be read. */
export const recordsOfRawTx = (tx: RawTx): MatchRecord[] => decodeMatchRecords(innerOfRawTx(tx));

export interface ReceiveDeps {
  store: WebhookStore;
  /** Runs `work` after the response (Next's `after`). Its failure must not reach the caller. */
  schedule: (work: () => Promise<unknown>) => void;
  /** The work to schedule: normally `decodePending`. */
  afterStore: () => Promise<unknown>;
  secret: string | undefined;
  /** Mark rows finalized when delivered (the webhook is set to finalized). */
  deliveredFinalized?: boolean;
}

const sameSecret = (authorization: string | null, secret: string) => {
  const given = Buffer.from((authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
};

/** The webhook route: checks the secret, stores each transaction by signature and answers; decoding is scheduled after the answer. */
export async function receiveWebhook(deps: ReceiveDeps, authorization: string | null, body: unknown): Promise<{ stored: number; duplicates: number; ignored: number }> {
  if (!deps.secret) throw new WebhookHttpError(503, "not-configured", "The history webhook is not configured on this server.");
  if (!sameSecret(authorization, deps.secret)) throw new WebhookHttpError(401, "unauthorized", "Not allowed.");
  const { txs, invalid } = parseWebhookBody(body);
  let stored = 0;
  let duplicates = 0;
  let ignored = invalid;
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) {
      ignored++;
      continue;
    }
    const fresh = await deps.store.put({ signature: signatureOf(tx), slot: tx.slot, blockTime: tx.blockTime ?? null, body: slim(tx), finalized: !!deps.deliveredFinalized });
    if (fresh) stored++;
    else duplicates++;
  }
  if (stored || duplicates) deps.schedule(deps.afterStore);
  return { stored, duplicates, ignored };
}

export interface DecodeDeps {
  store: WebhookStore;
  rpc: Rpc;
  limit?: number;
  warn?: (message: string) => void;
}

/**
 * Writes the history rows of the finalized stored transactions, oldest first. A transaction that cannot be decoded is marked
 * with its error and left; a database failure stops the pass and the row is offered again on the next one.
 */
export async function decodePending(deps: DecodeDeps): Promise<{ decoded: number; failed: number }> {
  let decoded = 0;
  let failed = 0;
  for (const row of await deps.store.toDecode(deps.limit ?? 200)) {
    let records: MatchRecord[];
    try {
      records = recordsOfRawTx(row.body);
    } catch (e) {
      const message = String((e as Error).message ?? e).split("\n")[0].slice(0, 300);
      deps.warn?.(`webhook transaction ${row.signature.slice(0, 8)} not decodable: ${message}`);
      await deps.store.markDecoded(row.signature, message);
      failed++;
      continue;
    }
    if (records.length) await ingestMatchRecords(deps.rpc, records, { signature: row.signature, slot: row.slot, blockTime: row.blockTime ?? undefined, finalized: true, gameOf: (p) => gameOfProgram(new PublicKey(p)) });
    await deps.store.markDecoded(row.signature, null);
    decoded++;
  }
  return { decoded, failed };
}

// ---- Catch-up ------------------------------------------------------------------------------------------------------

/** What the catch-up reads from the chain. */
export interface CoreChain {
  /** Signatures that touched core's event authority at finalized commitment, newest first, failed ones dropped. */
  signatures(opts: { before?: string; until?: string; limit: number }): Promise<string[]>;
  /** The raw transaction (json encoding); null when it cannot be read. */
  transaction(signature: string): Promise<RawTx | null>;
  /** Which of these signatures are finalized. */
  finalized(signatures: string[]): Promise<string[]>;
}

export interface CatchUpDeps {
  store: WebhookStore;
  chain: CoreChain;
  /** Signature pages read when there is no cursor yet. */
  firstPages?: number;
  maxPages?: number;
  pageSize?: number;
  concurrency?: number;
}

/**
 * Repairs what Helius dropped: stores every finalized core transaction after the cursor that the webhook did not deliver,
 * moves the cursor to the newest one stored, and marks delivered rows finalized once the chain has finalized them.
 * The cursor stops at the first transaction that cannot be read, so the next pass retries from there.
 */
export async function catchUp(deps: CatchUpDeps): Promise<{ stored: number; finalized: number; cursor: string | null }> {
  const size = deps.pageSize ?? 1000;
  const cursor = await deps.store.cursor();
  const newestFirst: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < (cursor ? (deps.maxPages ?? 200) : (deps.firstPages ?? 1)); page++) {
    const batch = await deps.chain.signatures({ before, until: cursor ?? undefined, limit: size });
    newestFirst.push(...batch);
    if (batch.length < size) break;
    before = batch[batch.length - 1];
  }
  const oldestFirst = newestFirst.reverse();
  let stored = 0;
  let reached: string | null = null;
  const fetched = new Array<RawTx | null>(oldestFirst.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(deps.concurrency ?? 6, oldestFirst.length) }, async () => {
    while (next < oldestFirst.length) {
      const i = next++;
      fetched[i] = await deps.chain.transaction(oldestFirst[i]).catch(() => null);
    }
  });
  await Promise.all(workers);
  for (let i = 0; i < oldestFirst.length; i++) {
    const tx = fetched[i];
    if (!tx) break;
    if (await deps.store.put({ signature: oldestFirst[i], slot: tx.slot, blockTime: tx.blockTime ?? null, body: slim(tx), finalized: true })) stored++;
    reached = oldestFirst[i];
  }
  if (reached) await deps.store.setCursor(reached);
  const pending = await deps.store.unfinalized(500);
  const done = pending.length ? await deps.chain.finalized(pending) : [];
  const finalized = done.length ? await deps.store.markFinalized(done) : 0;
  return { stored, finalized, cursor: reached ?? cursor };
}

// ---- Storage in the Match history database ------------------------------------------------------------------------

/** The functions of migration 0020 over `rpc`. */
export const rpcWebhookStore = (rpc: Rpc): WebhookStore => ({
  put: async (tx) => (await rpc("webhook_store_tx", { p: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, body: tx.body, finalized: tx.finalized } })) === true,
  toDecode: async (limit) => ((await rpc("webhook_to_decode", { p_limit: limit })) as { signature: string; slot: number; blockTime: number | null; body: RawTx }[]).map((r) => ({ signature: r.signature, slot: Number(r.slot), blockTime: r.blockTime == null ? null : Number(r.blockTime), body: r.body })),
  markDecoded: async (signature, error) => void (await rpc("webhook_mark_decoded", { p_signature: signature, p_error: error })),
  unfinalized: async (limit) => (await rpc("webhook_unfinalized", { p_limit: limit })) as string[],
  markFinalized: async (signatures) => Number(await rpc("webhook_mark_finalized", { p_signatures: signatures })),
  cursor: async () => ((await rpc("webhook_cursor_get", {})) as string | null) ?? null,
  setCursor: async (signature) => void (await rpc("webhook_cursor_set", { p_signature: signature })),
});

/** The chain reads over plain JSON-RPC. */
export function jsonRpcCoreChain(url: string, eventAuthority: string, fetchFn: typeof fetch = fetch): CoreChain {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`${method} failed: ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
    return json.result as T;
  };
  return {
    signatures: async ({ before, until, limit }) =>
      (await call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [eventAuthority, { before, until, limit, commitment: "finalized" }])).filter((s) => !s.err).map((s) => s.signature),
    transaction: async (signature) => call<RawTx | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]),
    finalized: async (signatures) => {
      const out: string[] = [];
      for (let i = 0; i < signatures.length; i += 100) {
        const chunk = signatures.slice(i, i + 100);
        const { value } = await call<{ value: ({ confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [chunk, { searchTransactionHistory: true }]);
        value.forEach((s, j) => s?.confirmationStatus === "finalized" && out.push(chunk[j]));
      }
      return out;
    },
  };
}
