import type { PublicKey } from "@solana/web3.js";

/**
 * What anyone may clean up for Players who are away (on a Break or Self-Excluded): unpaired (Open) Matches are refunded,
 * open Requests withdrawn, and unused (Open or Accepted) Offers of away Backers released. Paired Matches play out.
 * Pure: the page (for the Player starting a Break) and the keeper's daily janitor (for anything left behind) both plan with it.
 */

/** The end times (unix seconds, zero = none) of a Break and a Self-Exclusion. */
export interface AwayData {
  breakUntil: number;
  selfExclusionUntil: number;
}

export const NOT_AWAY: AwayData = { breakUntil: 0, selfExclusionUntil: 0 };

// ProtectionsState: disc 8, bump 1, account 32, entry_limit 40 bytes, then break_until and self_exclusion_until (i64 each).
const AT = 8 + 1 + 32 + 8 * 5;
/** The bytes a Protections account needs to hold both end times. */
export const AWAY_BYTES = AT + 16;

/** From the raw account bytes (the browser Buffer polyfill has no bigint accessors: DataView). */
export function decodeAway(data: Uint8Array): AwayData {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { breakUntil: Number(d.getBigInt64(AT, true)), selfExclusionUntil: Number(d.getBigInt64(AT + 8, true)) };
}

/** Whether a Player's Protections account (its bytes; null when there is none) has them on a Break or Self-Excluded at `now`. */
export function isAwayAt(data: Uint8Array | null | undefined, now: number): boolean {
  if (!data || data.length < AWAY_BYTES) return false;
  const a = decodeAway(data);
  return now < a.breakUntil || now < a.selfExclusionUntil;
}

export interface ProtectionRow {
  account: PublicKey;
  breakUntil: number;
  selfExclusionUntil: number;
}

/** The Accounts on a Break or Self-Excluded at `now` (unix seconds). */
export function awayAccounts(rows: ProtectionRow[], now: number): Set<string> {
  return new Set(rows.filter((p) => now < p.breakUntil || now < p.selfExclusionUntil).map((p) => p.account.toBase58()));
}

export interface OpenMatchRow {
  /** The Match's key in the app's id form. */
  id: string;
  stage: "open" | "active" | "settling" | "refunding" | "closed";
  game: PublicKey;
  /** The Account that opened it. */
  opener: PublicKey;
}
export interface AwayRequest {
  address: PublicKey;
  status: string;
  player: PublicKey;
}
export interface AwayOffer {
  address: PublicKey;
  status: string;
  backer: PublicKey;
  request: PublicKey;
}

export type AwayStep =
  | { kind: "refund-match"; matchId: string; game: PublicKey; owner: PublicKey }
  | { kind: "cancel-request"; request: PublicKey; owner: PublicKey }
  /** `request` is the Request an Accepted Offer hands back to Open, null for an Open Offer. */
  | { kind: "cancel-offer"; offer: PublicKey; request: PublicKey | null; owner: PublicKey };

export function planAway(away: Set<string>, matches: OpenMatchRow[], requests: AwayRequest[], offers: AwayOffer[]): AwayStep[] {
  const plan: AwayStep[] = [];
  if (away.size === 0) return plan;
  const isAway = (k: PublicKey) => away.has(k.toBase58());
  for (const m of matches) if (m.stage === "open" && isAway(m.opener)) plan.push({ kind: "refund-match", matchId: m.id, game: m.game, owner: m.opener });
  for (const r of requests) if (r.status === "open" && isAway(r.player)) plan.push({ kind: "cancel-request", request: r.address, owner: r.player });
  for (const o of offers) {
    if ((o.status === "open" || o.status === "accepted") && isAway(o.backer)) plan.push({ kind: "cancel-offer", offer: o.address, request: o.status === "accepted" ? o.request : null, owner: o.backer });
  }
  return plan;
}
