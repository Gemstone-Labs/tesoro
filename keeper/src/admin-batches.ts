import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BatchRule } from "./batches.ts";

/** A Sealed batch is sent again at most this often. */
export const DAY_SECS = 24 * 3600;

/** What the last send of a batch looked like: when, and how many units the vault had paid by then. */
export interface SendRecord {
  at: number;
  paid: string;
}

export interface SendHistory {
  get(batch: string): SendRecord | undefined;
  set(batch: string, record: SendRecord): void;
  all(): Record<string, SendRecord>;
}

export function memoryHistory(initial: Record<string, SendRecord> = {}): SendHistory {
  const rows = { ...initial };
  return { get: (b) => rows[b], set: (b, r) => void (rows[b] = r), all: () => rows };
}

/** Send records kept in a JSON file, written whole on every change; a missing or unreadable file is an empty history. */
export function fileHistory(path: string): SendHistory {
  let rows: Record<string, SendRecord> = {};
  try {
    if (existsSync(path)) rows = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    rows = {};
  }
  return {
    get: (b) => rows[b],
    set(b, r) {
      rows[b] = r;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(rows));
      renameSync(`${path}.tmp`, path);
    },
    all: () => rows,
  };
}

/**
 * The by-hand sweep of Platform and Studio fee batches for EVM Sources. Each send costs a LayerZero fee, and the vault pays
 * only as much as its yield has covered, so sending a batch again before the vault paid more burns fees for nothing. A Sealed
 * batch is sent when it never was, and again only when the vault has paid more than it had at the last send and a day has
 * passed. A batch an earlier run sent without a record here (`sends` above 0) is left alone: nothing says what was paid then.
 * The default scope is the by-hand sweep (Platform and Studio); the Season run asks for all classes and the prize payouts too,
 * and shares the record, so each side sees the other's sends.
 */
export function weeklyBatchRule(history: SendHistory, scope: { kinds: readonly number[]; payouts: boolean } = { kinds: [0, 1], payouts: false }): BatchRule {
  return {
    kinds: scope.kinds,
    payouts: scope.payouts,
    // A Pending payout is all or nothing, so only the day limit applies to it.
    canSendPayout(payout, nowMs) {
      const last = history.get(payout.address.toBase58());
      return !last || nowMs - last.at >= DAY_SECS * 1000;
    },
    sentPayout(payout, nowMs) {
      history.set(payout.address.toBase58(), { at: nowMs, paid: "0" });
    },
    canSend(batch, nowMs) {
      const last = history.get(batch.address.toBase58());
      if (!last) return batch.sends === 0;
      return batch.paidUnits > BigInt(last.paid) && nowMs - last.at >= DAY_SECS * 1000;
    },
    sent(batch, nowMs) {
      history.set(batch.address.toBase58(), { at: nowMs, paid: batch.paidUnits.toString() });
    },
  };
}
