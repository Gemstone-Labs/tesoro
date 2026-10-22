/** Friends limits (.scratch/friends/spec.md, founder Q10). The Postgres functions take these as arguments. */
export const MAX_FRIENDS = 500;
export const MAX_OUTGOING = 50;
export const REQUEST_DAYS = 30;
export const MAX_CHALLENGES_PER_DAY = 10;
export const SESSION_DAYS = 30;
export const LINK_REDEEMS_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FriendRequestRow {
  id: string;
  from: string;
  to: string;
  /** Epoch ms. */
  at: number;
  declinedAt: number | null;
}

/** Not declined and younger than 30 days: it can be accepted, and counts toward caps and the badge. */
export const isWaiting = (r: FriendRequestRow, now: number) => r.declinedAt === null && r.at > now - REQUEST_DAYS * DAY_MS;

/** What the sender sees as "Request sent": a waiting request, or one declined in the last 30 days (a decline is silent). */
export const showsAsSent = (r: FriendRequestRow, now: number) => isWaiting(r, now) || (r.declinedAt !== null && r.declinedAt > now - REQUEST_DAYS * DAY_MS);

/** The two Accounts of a friendship in stored order. */
export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** An add-me link code: 10 random base58 characters (~58 bits). */
export function newLinkCode(): string {
  const out: string[] = [];
  while (out.length < 10) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    // 58 * 4 = 232: dropping bytes >= 232 keeps every character equally likely.
    for (const x of b) if (x < 232 && out.length < 10) out.push(BASE58[x % 58]);
  }
  return out.join("");
}

export const isLinkCode = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{10}$/.test(s);

export type RequestStatus = "sent" | "friends" | "already-friends" | "self" | "friend-cap" | "their-cap" | "request-cap";
export type AcceptStatus = "friends" | "gone" | "friend-cap" | "their-cap";
export type RedeemStatus = "friends" | "already-friends" | "own" | "gone" | "friend-cap" | "their-cap";
export type ChallengeStatus = "recorded" | "not-friends" | "challenge-cap" | "duplicate";
