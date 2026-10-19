import type { Connection, PublicKey } from "@solana/web3.js";
import { fmtWhen } from "@/lib/format";
import { accountPda, protectionsPda } from "./native";

export const DAY_SECS = 24 * 60 * 60;
/** A Self-Exclusion month is 30 days (tesoro_core `MONTH_SECS`). */
export const MONTH_SECS = 30 * DAY_SECS;
export const BREAK_CHOICES = [1, 2, 3, 7, 14, 21, 28, 42];
export const BREAK_MAX_DAYS = 42;
export const SELF_EXCLUSION_CHOICES = [6, 12, 24, 36, 60];
export const SELF_EXCLUSION_MIN_MONTHS = 6;
export const SELF_EXCLUSION_MAX_MONTHS = 60;

/** The end times (unix seconds, zero = none) of a Break and a Self-Exclusion. */
export interface AwayData {
  breakUntil: number;
  selfExclusionUntil: number;
}

export const NOT_AWAY: AwayData = { breakUntil: 0, selfExclusionUntil: 0 };

// ProtectionsState: disc 8, bump 1, account 32, entry_limit 40 bytes, then break_until and self_exclusion_until (i64 each).
const AT = 8 + 1 + 32 + 8 * 5;

/** From the raw account bytes (the browser Buffer polyfill has no bigint accessors: DataView). */
export function decodeAway(data: Uint8Array): AwayData {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { breakUntil: Number(d.getBigInt64(AT, true)), selfExclusionUntil: Number(d.getBigInt64(AT + 8, true)) };
}

/** The owner's Break and Self-Exclusion; no Protections account yet means neither. */
export async function fetchAway(conn: Connection, owner: PublicKey): Promise<AwayData> {
  const info = await conn.getAccountInfo(protectionsPda(accountPda(owner)), "confirmed");
  return info && info.data.length >= AT + 16 ? decodeAway(info.data) : NOT_AWAY;
}

export interface AwayView {
  /** What is in force now; a Self-Exclusion wins when both run. */
  kind: "break" | "self-exclusion" | null;
  /** When it ends (unix seconds); null when nothing is in force. */
  until: number | null;
  breakUntil: number | null;
  selfExclusionUntil: number | null;
}

/** Mirrors `Protections::on_break` and `self_excluded`: in force while `now` is before the end. */
export function awayView(data: AwayData | null, now: number): AwayView {
  const d = data ?? NOT_AWAY;
  const breakUntil = now < d.breakUntil ? d.breakUntil : null;
  const selfExclusionUntil = now < d.selfExclusionUntil ? d.selfExclusionUntil : null;
  return {
    kind: selfExclusionUntil !== null ? "self-exclusion" : breakUntil !== null ? "break" : null,
    until: selfExclusionUntil ?? breakUntil,
    breakUntil,
    selfExclusionUntil,
  };
}

const at = (secs: number) => fmtWhen(secs * 1000);

/** The line entry points show in place of Play and Offer buttons; null when the Player is free to play. */
export function awayNotice(view: AwayView): string | null {
  if (view.kind === null || view.until === null) return null;
  return view.kind === "break" ? `On a Break until ${at(view.until)}` : `Self-Excluded until ${at(view.until)}`;
}

/** When a Break of `days` set now would end, and the same for a Self-Exclusion of `months`. */
export const breakEnd = (now: number, days: number) => now + days * DAY_SECS;
export const selfExclusionEnd = (now: number, months: number) => now + months * MONTH_SECS;

/** The choices that would not end the one in force earlier (the program refuses those). */
export function breakOptions(view: AwayView, now: number): number[] {
  return BREAK_CHOICES.filter((d) => view.breakUntil === null || breakEnd(now, d) >= view.breakUntil);
}
export function selfExclusionOptions(view: AwayView, now: number): number[] {
  return SELF_EXCLUSION_CHOICES.filter((m) => view.selfExclusionUntil === null || selfExclusionEnd(now, m) >= view.selfExclusionUntil);
}

export const breakLabel = (days: number) => (days === 1 ? "1 day" : `${days} days`);
export const selfExclusionLabel = (months: number) => (months % 12 === 0 ? `${months / 12} ${months === 12 ? "year" : "years"}` : `${months} months`);

/** The confirm step's wording: what starts, until when, and that it cannot be undone. */
export function confirmText(kind: "break" | "self-exclusion", until: number): string {
  const what =
    kind === "break"
      ? "You will not be able to enter Matches, post Requests or Offers, or be backed"
      : "You will not be able to enter Matches, post Requests or Offers, be backed, take an Advance or Extend one";
  return `${what} until ${at(until)}. This cannot be undone or shortened, not even by support. Matches already paired play out. Your waiting Matches, Requests and Offers are withdrawn. You can still Redeem, Unlock and pay back what you owe.`;
}
