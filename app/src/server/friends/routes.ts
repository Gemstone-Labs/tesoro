import { createHash, randomBytes } from "node:crypto";
import { parseAccountKey, accountKeyOf } from "@/lib/chain/account-key";
import type { GameId } from "@/lib/mock/types";
import { parseMatchKey } from "@/server/history/match-key";
import { DemoHttpError, NonceStore, envFromProcess, verifySignedRequest, type AuthEnv } from "../request-auth";
import { LINK_REDEEMS_PER_DAY, SESSION_DAYS, isLinkCode, newLinkCode } from "./rules";
import type { FriendsList, FriendsSession, FriendsStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** At most this many friend-Challenge emails a day from one Player to one Friend. */
export const CHALLENGE_EMAILS_PER_FRIEND = 3;

/** An open friend Challenge, as read from the chain. */
export interface OpenChallenge {
  game: GameId;
  entry: number;
  /** Account key of the Player who opened it. */
  opener: string;
}

export type FriendNotice =
  | { kind: "friend-request"; id: string; to: string }
  | { kind: "friend-challenge"; id: string; to: string; matchId: string; game: GameId; entry: number };

export interface FriendsDeps {
  store: FriendsStore;
  /** The Challenge Match if it is open, before its deadline, with its second seat free, else null. */
  openChallenge: (matchId: string) => Promise<OpenChallenge | null>;
  /** The same for many Matches in one read (the list); falls back to one read each. */
  openChallenges?: (matchIds: string[]) => Promise<(OpenChallenge | null)[]>;
  /** Emails a Friend notice when the Player opted in. Never throws into the route. */
  notify?: (n: FriendNotice) => Promise<void>;
  now?: () => number;
  env?: AuthEnv;
  newCode?: () => string;
  newToken?: () => string;
}

/** `__Host-` keeps it to this exact host and needs HTTPS; plain http (local dev, a phone preview) uses the bare name. */
export const sessionCookieName = (https: boolean) => (https ? "__Host-tesoro-friends" : "tesoro-friends");

export function sessionCookie(name: string, token: string, maxAgeSecs: number, https: boolean): string {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSecs}${https ? "; Secure" : ""}`;
}

/** Whether the browser reached us over HTTPS (Vercel and other proxies say so in x-forwarded-proto). */
export const requestIsHttps = (request: Request) => (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")).split(",")[0].trim() === "https";

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const sessionNonces = new NonceStore();

/**
 * Starts a Friends session: one wallet signature (scope tesoro-friends, step session) for 30 days. The
 * nonce is also stored with the session, so a signature can't be replayed on another server instance.
 */
export async function startSession(deps: FriendsDeps, body: unknown, authorization: string | null): Promise<{ account: string; token: string; maxAgeSecs: number }> {
  const now = (deps.now ?? Date.now)();
  const req = await verifySignedRequest("tesoro-friends", ["session"] as const, body, authorization, { nonces: sessionNonces, env: deps.env, now });
  const token = (deps.newToken ?? (() => randomBytes(32).toString("base64url")))();
  const authority = req.address.toBase58();
  const session: FriendsSession = { account: accountKeyOf(authority), authority, privySub: req.sub, expiresAt: now + SESSION_DAYS * DAY_MS };
  const nonce = (body as { nonce: string }).nonce;
  if (!(await deps.store.createSession(hashToken(token), session, nonce))) throw new DemoHttpError(401, "replayed", "Request already used. Try again.");
  return { account: session.account, token, maxAgeSecs: SESSION_DAYS * 24 * 60 * 60 };
}

export interface FriendsContext {
  /** The session cookie's value, if any. */
  token: string | null;
  authorization: string | null;
  origin: string | null;
  host: string | null;
}

export interface FriendsView extends FriendsList {
  me: string;
  challenges: (FriendsList["challenges"][number] & { game: GameId; entry: number })[];
  /** Waiting requests + open Challenges for me + new Friends I haven't seen. */
  badge: number;
}

const redeems = new Map<string, { day: number; n: number }>();

function account(raw: unknown): string {
  const k = typeof raw === "string" ? parseAccountKey(raw) : null;
  if (!k) throw new DemoHttpError(400, "bad-request", "Not an Account.");
  return k.key.toBase58();
}

async function session(deps: FriendsDeps, ctx: FriendsContext, now: number): Promise<{ s: FriendsSession; hash: string }> {
  const env = deps.env ?? envFromProcess();
  // Every change is a POST from our own pages: a cross-site form or script can't ride the cookie.
  let sameSite = false;
  try {
    sameSite = !!ctx.origin && !!ctx.host && new URL(ctx.origin).host === ctx.host;
  } catch {
    sameSite = false;
  }
  if (!sameSite) throw new DemoHttpError(403, "bad-origin", "Request refused.");
  if (!ctx.token) throw new DemoHttpError(401, "no-session", "Sign in to Friends to continue.");
  const hash = hashToken(ctx.token);
  const s = await deps.store.getSession(hash, now);
  if (!s) throw new DemoHttpError(401, "no-session", "Sign in to Friends to continue.");
  if (env.privyAppId && !env.devWallet) {
    const token = ctx.authorization?.replace(/^Bearer\s+/i, "");
    const sub = token ? await env.verifyToken(token, env.privyAppId) : null;
    // Signed out of Privy, or a different person signed in on this browser: the session ends with it.
    if (!sub || sub !== s.privySub) throw new DemoHttpError(401, "no-session", "Sign in to Friends to continue.");
  }
  return { s, hash };
}

const quiet = (deps: FriendsDeps, n: FriendNotice) => {
  if (!deps.notify) return Promise.resolve();
  return deps.notify(n).catch((e) => console.error("friends-notify", e));
};

/** Every Friends action for the signed-in Account (body.op). Answers plain statuses; the list is its own op. */
export async function handleFriends(deps: FriendsDeps, body: unknown, ctx: FriendsContext): Promise<{ result: unknown; signOut?: boolean }> {
  const now = (deps.now ?? Date.now)();
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { s, hash } = await session(deps, ctx, now);
  const me = s.account;
  const newCode = deps.newCode ?? newLinkCode;
  switch (b.op) {
    case "list":
      return { result: await view(deps, me, now) };
    case "request": {
      const r = await deps.store.request(me, account(b.to), now);
      if (r.requestId) await quiet(deps, { kind: "friend-request", id: `friend-request:${r.requestId}`, to: account(b.to) });
      return { result: { status: r.status } };
    }
    case "accept":
      return { result: { status: await deps.store.accept(me, account(b.from), now) } };
    case "decline":
      await deps.store.decline(me, account(b.from), now);
      return { result: { status: "declined" } };
    case "remove":
      await deps.store.remove(me, account(b.account));
      return { result: { status: "removed" } };
    case "link":
      return { result: { code: await deps.store.link(me, newCode()) } };
    case "reset-link":
      return { result: { code: await deps.store.resetLink(me, newCode()) } };
    case "redeem": {
      if (!isLinkCode(b.code)) return { result: { status: "gone" } };
      const day = Math.floor(now / DAY_MS);
      const used = redeems.get(me);
      const n = used?.day === day ? used.n : 0;
      if (n >= LINK_REDEEMS_PER_DAY) throw new DemoHttpError(429, "too-many", "Too many add-me links today. Try again tomorrow.");
      redeems.set(me, { day, n: n + 1 });
      const r = await deps.store.redeem(me, b.code, now);
      return { result: r };
    }
    case "challenge": {
      const matchId = typeof b.matchId === "string" && parseMatchKey(b.matchId) ? b.matchId : null;
      if (!matchId) throw new DemoHttpError(400, "bad-request", "Malformed request.");
      const to = account(b.to);
      const open = await deps.openChallenge(matchId);
      if (!open || open.opener !== me) throw new DemoHttpError(400, "not-your-challenge", "That Challenge isn't open.");
      const r = await deps.store.challenge(me, to, matchId, now);
      if (r.status === "recorded" && (r.toThisFriendToday ?? 0) <= CHALLENGE_EMAILS_PER_FRIEND) {
        await quiet(deps, { kind: "friend-challenge", id: `friend-challenge:${matchId}`, to, matchId, game: open.game, entry: open.entry });
      }
      return { result: { status: r.status } };
    }
    case "seen":
      await deps.store.markSeen(me);
      return { result: { status: "seen" } };
    case "sign-out":
      await deps.store.deleteSession(hash);
      return { result: { status: "signed-out" }, signOut: true };
    default:
      throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
}

async function view(deps: FriendsDeps, me: string, now: number): Promise<FriendsView> {
  const list = await deps.store.list(me, now);
  const ids = list.challenges.map((c) => c.matchId);
  const opens = ids.length
    ? await (deps.openChallenges ?? ((xs: string[]) => Promise.all(xs.map((x) => deps.openChallenge(x).catch(() => null)))))(ids).catch(() => ids.map(() => null))
    : [];
  const challenges = list.challenges
    .map((c, i) => {
      const open = opens[i];
      return open && open.opener === c.from ? { ...c, game: open.game, entry: open.entry } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  return { me, ...list, challenges, badge: list.incoming.length + challenges.length + list.friends.filter((f) => f.isNew).length };
}
