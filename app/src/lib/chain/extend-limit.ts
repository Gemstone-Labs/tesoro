import type { Connection, PublicKey } from "@solana/web3.js";
import { accountPda, extendLimitPda } from "./native";

/** An Advance commits at most 12 months of yield. */
export const MAX_ADVANCE_MONTHS = 12;

/** Months Extend may add in one period until the Player sets their own limit (ADR 0009). */
export const DEFAULT_EXTEND_LIMIT = 3;
/** Highest limit a Player can set. */
export const MAX_EXTEND_LIMIT = 11;
export const EXTEND_WAIT_SECS = 24 * 60 * 60;
export const EXTEND_PERIOD_SECS = 30 * 24 * 60 * 60;

/** The program's `ExtendLimit`, times in unix seconds of the real clock. */
export interface ExtendLimitData {
  months: number;
  pendingMonths: number;
  pendingAt: number;
  windowStart: number;
  windowMonths: number;
  lastExtendAt: number;
}

export const DEFAULT_EXTEND_LIMIT_DATA: ExtendLimitData = { months: DEFAULT_EXTEND_LIMIT, pendingMonths: 0, pendingAt: 0, windowStart: 0, windowMonths: 0, lastExtendAt: 0 };

// ExtendLimitState: disc 8, bump 1, account 32, then months, pending_months, pending_at, window_start, window_months, last_extend_at.
const AT = 8 + 1 + 32;

/** From the raw account bytes (the browser Buffer polyfill has no bigint accessors: DataView). */
export function decodeExtendLimit(data: Uint8Array): ExtendLimitData {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    months: d.getUint8(AT),
    pendingMonths: d.getUint8(AT + 1),
    pendingAt: Number(d.getBigInt64(AT + 2, true)),
    windowStart: Number(d.getBigInt64(AT + 10, true)),
    windowMonths: d.getUint8(AT + 18),
    lastExtendAt: Number(d.getBigInt64(AT + 19, true)),
  };
}

/** The owner's Extend Limit; no account yet means the default with nothing used. */
export async function fetchExtendLimit(conn: Connection, owner: PublicKey): Promise<ExtendLimitData> {
  const info = await conn.getAccountInfo(extendLimitPda(accountPda(owner)), "confirmed");
  return info && info.data.length >= AT + 27 ? decodeExtendLimit(info.data) : DEFAULT_EXTEND_LIMIT_DATA;
}

export type ExtendBlock =
  | { kind: "waiting"; until: number }
  | { kind: "limit"; until: number }
  | { kind: "off" }
  | { kind: "full" };

export interface ExtendLimitView {
  /** The limit in force now. */
  limit: number;
  /** A raise still waiting for its time. */
  pending: { months: number; at: number } | null;
  /** Months added so far in this 30-day period, what is left of the limit, and when the period resets (null = no period running). */
  used: number;
  remaining: number;
  resetsAt: number | null;
  /** When the 24 h wait ends (null = not waiting). */
  nextExtendAt: number | null;
  /** The most months the picker may offer: the limit left, and what the 12-month Horizon has room for. */
  maxMonths: number;
  /** Why Extend cannot be sent right now, in the order the program checks. */
  blocked: ExtendBlock | null;
  /** Months of the 12 this Advance already commits. */
  committed: number;
}

/** What the Extend sheet shows, mirroring `ExtendLimit::record_extend` in tesoro_core. `limit` is null before the account exists. */
export function extendLimitView(limit: ExtendLimitData | null, now: number, horizonMonths: number): ExtendLimitView {
  const l = limit ?? DEFAULT_EXTEND_LIMIT_DATA;
  const raised = l.pendingAt !== 0 && now >= l.pendingAt;
  const months = raised ? l.pendingMonths : l.months;
  const pending = l.pendingAt !== 0 && !raised ? { months: l.pendingMonths, at: l.pendingAt } : null;
  const periodRunning = l.windowStart !== 0 && now < l.windowStart + EXTEND_PERIOD_SECS;
  const used = periodRunning ? l.windowMonths : 0;
  const resetsAt = periodRunning ? l.windowStart + EXTEND_PERIOD_SECS : null;
  const remaining = Math.max(0, months - used);
  const nextExtendAt = l.lastExtendAt !== 0 && now < l.lastExtendAt + EXTEND_WAIT_SECS ? l.lastExtendAt + EXTEND_WAIT_SECS : null;
  const room = Math.max(0, MAX_ADVANCE_MONTHS - horizonMonths);
  const maxMonths = Math.min(remaining, room);
  let blocked: ExtendBlock | null = null;
  if (nextExtendAt !== null) blocked = { kind: "waiting", until: nextExtendAt };
  else if (months === 0) blocked = { kind: "off" };
  else if (room === 0) blocked = { kind: "full" };
  else if (remaining === 0 && resetsAt !== null) blocked = { kind: "limit", until: resetsAt };
  return { limit: months, pending, used, remaining, resetsAt, nextExtendAt, maxMonths, blocked, committed: horizonMonths };
}
