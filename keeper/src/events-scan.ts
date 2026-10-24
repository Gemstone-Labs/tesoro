import type { ConfirmedSignatureInfo, Connection } from "@solana/web3.js";
import { decodeMatchRecords, innerInstructionsOf, type MatchRecord, type MatchWonRecord } from "../../app/src/server/history/events.ts";
import type { Win } from "../../app/src/lib/chain/season.ts";
import { eventAuthority } from "./kit.ts";

/** What the scan reads from a connection. */
export type ScanConn = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

/** A transaction of tesoro_core that emitted Match records. */
export interface TxRecords {
  signature: string;
  slot: number;
  blockTime: number | null;
  records: MatchRecord[];
  finalized?: boolean;
}

export interface CollectOpts {
  /** Stop at this signature (the newest one already handled). */
  until?: string;
  /** Stop once a page reaches transactions older than this block time (unix seconds). */
  olderThan?: number;
  maxPages?: number;
  pageSize?: number;
}

/**
 * The signatures of transactions that touched core's event authority, newest first, failed ones dropped. Every
 * event-CPI of core carries that account, so this is exactly the list of transactions that emitted a record (plus
 * anything a stranger put the account into; `decodeMatchRecords` ignores those).
 */
export async function collectSignatures(conn: ScanConn, opts: CollectOpts = {}): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  const size = opts.pageSize ?? 1000;
  let before: string | undefined;
  let reachedEnd = false;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const batch = await conn.getSignaturesForAddress(eventAuthority, { before, until: opts.until, limit: size }, "finalized");
    if (!batch.length) {
      reachedEnd = true;
      break;
    }
    let older = false;
    for (const s of batch) {
      if (opts.olderThan !== undefined && s.blockTime != null && s.blockTime < opts.olderThan) older = true;
      else if (!s.err) out.push(s);
    }
    if (older || batch.length < size) {
      reachedEnd = true;
      break;
    }
    before = batch[batch.length - 1].signature;
  }
  if (!reachedEnd) throw new Error(`event scan stopped after ${opts.maxPages ?? 20} page(s) before reaching ${opts.olderThan !== undefined ? new Date(opts.olderThan * 1000).toISOString() : opts.until ?? "the end of history"}; raise maxPages`);
  return out;
}

/** The Match records of one transaction; null when it cannot be read (pruned, dropped). */
export async function transactionRecords(conn: ScanConn, sig: ConfirmedSignatureInfo): Promise<TxRecords | null> {
  const tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
  if (!tx) return null;
  return { signature: sig.signature, slot: tx.slot, blockTime: tx.blockTime ?? sig.blockTime ?? null, records: decodeMatchRecords(innerInstructionsOf(tx as any)), finalized: true };
}

/** `fn` over `items` with at most `n` in flight; results keep the order of `items`. */
export async function pooled<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const wonCache = new Map<string, MatchWonRecord[]>();

export const winOf = (r: MatchWonRecord): Win => ({ player: r.winner, points: r.points, ts: r.ts, matchId: `${r.opener}-${r.n}`, ...(r.loser && r.loser !== "11111111111111111111111111111111" ? { loser: r.loser } : {}) });

/**
 * Every Match won in Season `n`, from core's events. `startSecs`..`endSecs` is the Season's time span; transactions up
 * to `slackSecs` after it are read too (a settle at the boundary), and each record's own `season` decides. Records
 * are cached per signature only after finalization.
 */
export async function seasonWinsFromChain(conn: ScanConn, n: number, startSecs: number, endSecs: number, slackSecs = 2 * 3600, concurrency = 6, scan: CollectOpts = {}): Promise<Win[]> {
  const sigs = (await collectSignatures(conn, { olderThan: startSecs, maxPages: 200, ...scan })).filter((s) => s.blockTime == null || (s.blockTime >= startSecs && s.blockTime < endSecs + slackSecs));
  const todo = sigs.filter((s) => !wonCache.has(s.signature));
  await pooled(todo, concurrency, async (s) => {
    const tx = await transactionRecords(conn, s);
    if (tx) wonCache.set(s.signature, tx.records.filter((r): r is MatchWonRecord => r.type === "won"));
  });
  // A win we could not read would drop a Player from the ranking: never rank on a partial scan.
  const unreadable = sigs.filter((s) => !wonCache.has(s.signature)).length;
  if (unreadable) throw new Error(`season ${n}: ${unreadable} transaction(s) could not be read; not ranking on a partial scan`);
  const wins: MatchWonRecord[] = [];
  for (const s of sigs) for (const r of wonCache.get(s.signature) ?? []) if (r.season === n) wins.push(r);
  return wins.sort((a, b) => a.ts - b.ts).map(winOf);
}
