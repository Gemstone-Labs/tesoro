import type { Connection, PublicKey } from "@solana/web3.js";
import { fmtWhen } from "@/lib/format";
import { accountPda, protectionsPda } from "./native";

/** The Entry Limit counts Gemas entered in a 7-day period that starts at the first entry after the last one ended. */
export const ENTRY_PERIOD_SECS = 7 * 24 * 60 * 60;
/** A raised limit, or removing the limit, takes effect this long after it is set. */
export const ENTRY_RAISE_WAIT_SECS = 24 * 60 * 60;
/** The choices the picker offers; a limit set another way is added to the list. Zero is no limit. */
export const ENTRY_LIMIT_CHOICES = [0, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000];

/** The program's `EntryLimit` (zero `gemas` = no limit), times in unix seconds of the real clock. */
export interface EntryLimitData {
  gemas: number;
  pendingGemas: number;
  pendingAt: number;
  windowStart: number;
  windowUsed: number;
}

export const NO_ENTRY_LIMIT: EntryLimitData = { gemas: 0, pendingGemas: 0, pendingAt: 0, windowStart: 0, windowUsed: 0 };

// ProtectionsState: disc 8, bump 1, account 32, then entry_limit { gemas, pending_gemas, pending_at, window_start, window_used }.
// After it come the reserved Break and Self-Exclusion fields (ticket 23), which this view does not read.
const AT = 8 + 1 + 32;
const ENTRY_BYTES = 8 * 5;

/** From the raw account bytes (the browser Buffer polyfill has no bigint accessors: DataView). */
export function decodeEntryLimit(data: Uint8Array): EntryLimitData {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    gemas: Number(d.getBigUint64(AT, true)),
    pendingGemas: Number(d.getBigUint64(AT + 8, true)),
    pendingAt: Number(d.getBigInt64(AT + 16, true)),
    windowStart: Number(d.getBigInt64(AT + 24, true)),
    windowUsed: Number(d.getBigUint64(AT + 32, true)),
  };
}

/** The owner's Entry Limit; no Protections account yet means no limit. */
export async function fetchEntryLimit(conn: Connection, owner: PublicKey): Promise<EntryLimitData> {
  const info = await conn.getAccountInfo(protectionsPda(accountPda(owner)), "confirmed");
  return info && info.data.length >= AT + ENTRY_BYTES ? decodeEntryLimit(info.data) : NO_ENTRY_LIMIT;
}

export interface EntryLimitView {
  /** The limit in force now, in Gemas (null = none). */
  limit: number | null;
  /** A change still waiting for its time: `gemas` null = the limit is being removed. */
  pending: { gemas: number | null; at: number } | null;
  /** Gemas entered so far in this period, what is left (null = no limit), and when the period resets (null = none running). */
  used: number;
  remaining: number | null;
  resetsAt: number | null;
}

/** What the Limits screen shows, mirroring `EntryLimit::effective`, `used` and `record_entry` in tesoro_core. `data` is null while it loads or unread. */
export function entryLimitView(data: EntryLimitData | null, now: number): EntryLimitView {
  const l = data ?? NO_ENTRY_LIMIT;
  const raised = l.pendingAt !== 0 && now >= l.pendingAt;
  const gemas = raised ? l.pendingGemas : l.gemas;
  const pending = l.pendingAt !== 0 && !raised ? { gemas: l.pendingGemas === 0 ? null : l.pendingGemas, at: l.pendingAt } : null;
  const running = l.windowStart !== 0 && now < l.windowStart + ENTRY_PERIOD_SECS;
  const used = running ? l.windowUsed : 0;
  return {
    limit: gemas === 0 ? null : gemas,
    pending,
    used,
    remaining: gemas === 0 ? null : Math.max(0, gemas - used),
    resetsAt: running && gemas !== 0 ? l.windowStart + ENTRY_PERIOD_SECS : null,
  };
}

const cap = (n: number | null) => (n === null || n === 0 ? Number.POSITIVE_INFINITY : n);

/**
 * What setting the limit to `gemas` (0 = none) does, mirroring `EntryLimit::set_limit`: the value already pending changes
 * nothing, the value in force cancels a pending raise (or changes nothing), a lower value applies now, a higher one waits 24 h.
 */
export function entryLimitChange(view: EntryLimitView, gemas: number): "same" | "cancel" | "lower" | "raise" {
  const next = gemas === 0 ? null : gemas;
  if (view.pending && next === view.pending.gemas) return "same";
  if (next === view.limit) return view.pending ? "cancel" : "same";
  return cap(next) > cap(view.limit) ? "raise" : "lower";
}

/** The picker's options: the standard choices plus a limit in force or pending that is not one of them. */
export function entryLimitOptions(view: EntryLimitView): number[] {
  const extra = [view.limit, view.pending?.gemas].filter((g): g is number => g != null && !ENTRY_LIMIT_CHOICES.includes(g));
  return [...ENTRY_LIMIT_CHOICES, ...extra].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

const at = (secs: number) => fmtWhen(secs * 1000);

/** One line on the limit in force and what is left of it. */
export function entryLimitSummary(view: EntryLimitView): string {
  if (view.limit === null) return "No Entry Limit is set.";
  const left = `${view.remaining!.toLocaleString("en-US")} left`;
  return view.resetsAt !== null ? `${left} of ${view.limit.toLocaleString("en-US")} Gemas · resets ${at(view.resetsAt)}.` : `${view.limit.toLocaleString("en-US")} Gemas in any 7 days, none used yet.`;
}

export function entryPendingNote(p: NonNullable<EntryLimitView["pending"]>): string {
  return p.gemas === null ? `Your limit is removed at ${at(p.at)}.` : `Your limit rises to ${p.gemas.toLocaleString("en-US")} Gemas at ${at(p.at)}.`;
}
