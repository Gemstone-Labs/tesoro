import { MAX_CHALLENGES_PER_DAY, MAX_FRIENDS, MAX_OUTGOING, isWaiting, pairOf, showsAsSent, type AcceptStatus, type ChallengeStatus, type FriendRequestRow, type RedeemStatus, type RequestStatus } from "./rules";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FriendsSession {
  account: string;
  authority: string;
  privySub: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

export interface FriendsList {
  friends: { account: string; since: number; isNew: boolean }[];
  /** Waiting requests to me. */
  incoming: { account: string; at: number }[];
  /** Requests I sent that still show as "Request sent". */
  outgoing: { account: string; at: number }[];
  /** Friend Challenges to me from the last 2 days; the route keeps only Matches still open. */
  challenges: { matchId: string; from: string; at: number }[];
}

/**
 * Friends storage. Each change is atomic: Supabase runs it in one locked Postgres function
 * (migration 0007_friends.sql); the memory store is single-threaded. Both follow the same rules.
 */
export interface FriendsStore {
  /** `requestId` only when a new request was written (so it is announced once). */
  request(from: string, to: string, now: number): Promise<{ status: RequestStatus; requestId?: string }>;
  accept(me: string, from: string, now: number): Promise<AcceptStatus>;
  decline(me: string, from: string, now: number): Promise<void>;
  remove(me: string, other: string): Promise<void>;
  redeem(me: string, code: string, now: number): Promise<{ status: RedeemStatus; owner?: string }>;
  /** `toThisFriendToday`: friend Challenges from `from` to `to` in the last day, this one included. */
  challenge(from: string, to: string, matchId: string, now: number): Promise<{ status: ChallengeStatus; toThisFriendToday?: number }>;
  /** My add-me link code, made with `newCode` the first time. */
  link(me: string, newCode: string): Promise<string>;
  resetLink(me: string, newCode: string): Promise<string>;
  linkOwner(code: string): Promise<string | null>;
  list(me: string, now: number): Promise<FriendsList>;
  markSeen(me: string): Promise<void>;
  /** False when the nonce was already used (a replayed signature). */
  createSession(tokenHash: string, s: FriendsSession, nonce: string): Promise<boolean>;
  getSession(tokenHash: string, now: number): Promise<FriendsSession | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

interface Friendship {
  a: string;
  b: string;
  since: number;
  aSeen: boolean;
  bSeen: boolean;
}

/** In memory, for tests and local work. Mirrors the Postgres functions. */
export class MemoryFriendsStore implements FriendsStore {
  readonly requests = new Map<string, FriendRequestRow>();
  readonly friendships = new Map<string, Friendship>();
  readonly links = new Map<string, string>();
  readonly challenges = new Map<string, { from: string; to: string; at: number }>();
  readonly sessions = new Map<string, FriendsSession>();
  readonly nonces = new Set<string>();
  private nextId = 1;

  private rk = (from: string, to: string) => `${from}>${to}`;
  private fk = (x: string, y: string) => pairOf(x, y).join("|");
  private are = (x: string, y: string) => this.friendships.has(this.fk(x, y));
  private count = (acct: string) => [...this.friendships.values()].filter((f) => f.a === acct || f.b === acct).length;

  private make(actor: string, other: string, now: number) {
    const [a, b] = pairOf(actor, other);
    if (!this.friendships.has(this.fk(a, b))) this.friendships.set(this.fk(a, b), { a, b, since: now, aSeen: a === actor, bSeen: b === actor });
    this.requests.delete(this.rk(actor, other));
    this.requests.delete(this.rk(other, actor));
  }

  async request(from: string, to: string, now: number): Promise<{ status: RequestStatus; requestId?: string }> {
    if (from === to) return { status: "self" };
    if (this.are(from, to)) return { status: "already-friends" };
    const theirs = this.requests.get(this.rk(to, from));
    if (theirs && isWaiting(theirs, now)) {
      if (this.count(from) >= MAX_FRIENDS) return { status: "friend-cap" };
      if (this.count(to) >= MAX_FRIENDS) return { status: "their-cap" };
      this.make(from, to, now);
      return { status: "friends" };
    }
    const mine = this.requests.get(this.rk(from, to));
    if (mine && showsAsSent(mine, now)) return { status: "sent" };
    if (this.count(from) >= MAX_FRIENDS) return { status: "friend-cap" };
    if ([...this.requests.values()].filter((r) => r.from === from && isWaiting(r, now)).length >= MAX_OUTGOING) return { status: "request-cap" };
    const id = `r${this.nextId++}`;
    this.requests.set(this.rk(from, to), { id, from, to, at: now, declinedAt: null });
    return { status: "sent", requestId: id };
  }

  async accept(me: string, from: string, now: number): Promise<AcceptStatus> {
    if (this.are(me, from)) return "friends";
    const r = this.requests.get(this.rk(from, me));
    if (!r || !isWaiting(r, now)) return "gone";
    if (this.count(me) >= MAX_FRIENDS) return "friend-cap";
    if (this.count(from) >= MAX_FRIENDS) return "their-cap";
    this.make(me, from, now);
    return "friends";
  }

  async decline(me: string, from: string, now: number) {
    const r = this.requests.get(this.rk(from, me));
    if (r && isWaiting(r, now)) r.declinedAt = now;
  }

  async remove(me: string, other: string) {
    this.friendships.delete(this.fk(me, other));
    this.requests.delete(this.rk(me, other));
    this.requests.delete(this.rk(other, me));
  }

  async redeem(me: string, code: string, now: number): Promise<{ status: RedeemStatus; owner?: string }> {
    const owner = await this.linkOwner(code);
    if (!owner) return { status: "gone" };
    if (owner === me) return { status: "own", owner };
    if (this.are(me, owner)) return { status: "already-friends", owner };
    if (this.count(me) >= MAX_FRIENDS) return { status: "friend-cap", owner };
    if (this.count(owner) >= MAX_FRIENDS) return { status: "their-cap", owner };
    this.make(me, owner, now);
    return { status: "friends", owner };
  }

  async challenge(from: string, to: string, matchId: string, now: number): Promise<{ status: ChallengeStatus; toThisFriendToday?: number }> {
    if (!this.are(from, to)) return { status: "not-friends" };
    for (const [id, c] of this.challenges) if (c.from === from && c.at < now - 7 * DAY_MS) this.challenges.delete(id);
    if ([...this.challenges.values()].filter((c) => c.from === from && c.at > now - DAY_MS).length >= MAX_CHALLENGES_PER_DAY) return { status: "challenge-cap" };
    if (this.challenges.has(matchId)) return { status: "duplicate" };
    this.challenges.set(matchId, { from, to, at: now });
    const toThisFriendToday = [...this.challenges.values()].filter((c) => c.from === from && c.to === to && c.at > now - DAY_MS).length;
    return { status: "recorded", toThisFriendToday };
  }

  async link(me: string, newCode: string) {
    const code = this.links.get(me) ?? newCode;
    this.links.set(me, code);
    return code;
  }

  async resetLink(me: string, newCode: string) {
    this.links.set(me, newCode);
    return newCode;
  }

  async linkOwner(code: string) {
    for (const [acct, c] of this.links) if (c === code) return acct;
    return null;
  }

  async list(me: string, now: number): Promise<FriendsList> {
    const friends = [...this.friendships.values()]
      .filter((f) => f.a === me || f.b === me)
      .map((f) => ({ account: f.a === me ? f.b : f.a, since: f.since, isNew: f.a === me ? !f.aSeen : !f.bSeen }));
    const reqs = [...this.requests.values()];
    return {
      friends,
      incoming: reqs.filter((r) => r.to === me && isWaiting(r, now)).map((r) => ({ account: r.from, at: r.at })),
      outgoing: reqs.filter((r) => r.from === me && showsAsSent(r, now)).map((r) => ({ account: r.to, at: r.at })),
      challenges: [...this.challenges]
        .filter(([, c]) => c.to === me && c.at > now - 2 * DAY_MS && this.are(me, c.from))
        .map(([matchId, c]) => ({ matchId, from: c.from, at: c.at })),
    };
  }

  async markSeen(me: string) {
    for (const f of this.friendships.values()) {
      if (f.a === me) f.aSeen = true;
      if (f.b === me) f.bSeen = true;
    }
  }

  async createSession(tokenHash: string, s: FriendsSession, nonce: string) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    this.sessions.set(tokenHash, s);
    return true;
  }

  async getSession(tokenHash: string, now: number) {
    const s = this.sessions.get(tokenHash);
    return s && s.expiresAt > now ? s : null;
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
}
