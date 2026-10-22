import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MAX_CHALLENGES_PER_DAY, MAX_FRIENDS, MAX_OUTGOING, showsAsSent, isWaiting, type AcceptStatus, type ChallengeStatus, type RedeemStatus, type RequestStatus } from "./rules";
import type { FriendsList, FriendsSession, FriendsStore } from "./store";

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Friends storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null) => (s === null ? null : Date.parse(s));

async function call(fn: string, args: Record<string, unknown>): Promise<string> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`Friends ${fn} failed: ${error.message}`);
  return String(data);
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`Friends ${what} failed: ${error.message}`);
  return data;
}

/** Postgres through the service role (migration 0007_friends.sql); every change is one locked function. */
export const supabaseFriendsStore: FriendsStore = {
  async request(from, to, now) {
    const r = await call("friends_request", { p_from: from, p_to: to, p_now: iso(now), p_max_friends: MAX_FRIENDS, p_max_out: MAX_OUTGOING });
    if (r.startsWith("requested:")) return { status: "sent", requestId: r.slice("requested:".length) };
    return { status: r as RequestStatus };
  },
  async accept(me, from, now) {
    return (await call("friends_accept", { p_me: me, p_from: from, p_now: iso(now), p_max_friends: MAX_FRIENDS })) as AcceptStatus;
  },
  async decline(me, from, now) {
    await call("friends_decline", { p_me: me, p_from: from, p_now: iso(now) });
  },
  async remove(me, other) {
    await call("friends_remove", { p_me: me, p_other: other });
  },
  async redeem(me, code, now) {
    const status = (await call("friends_redeem", { p_me: me, p_code: code, p_now: iso(now), p_max_friends: MAX_FRIENDS })) as RedeemStatus;
    return status === "gone" ? { status } : { status, owner: (await this.linkOwner(code)) ?? undefined };
  },
  async challenge(from, to, matchId, now) {
    const r = await call("friends_challenge", { p_from: from, p_to: to, p_match: matchId, p_now: iso(now), p_max_per_day: MAX_CHALLENGES_PER_DAY });
    if (r.startsWith("recorded:")) return { status: "recorded", toThisFriendToday: Number(r.slice("recorded:".length)) };
    return { status: r as ChallengeStatus };
  },
  async link(me, newCode) {
    await check(db().from("friend_links").upsert({ account: me, code: newCode }, { onConflict: "account", ignoreDuplicates: true }), "link save");
    const row = await check(db().from("friend_links").select("code").eq("account", me).single(), "link read");
    return (row as { code: string }).code;
  },
  async resetLink(me, newCode) {
    await check(db().from("friend_links").upsert({ account: me, code: newCode, created_at: new Date().toISOString() }, { onConflict: "account" }), "link reset");
    return newCode;
  },
  async linkOwner(code) {
    const row = await check(db().from("friend_links").select("account").eq("code", code).maybeSingle(), "link lookup");
    return (row as { account: string } | null)?.account ?? null;
  },
  async list(me, now): Promise<FriendsList> {
    const [fa, fb, inc, out, ch] = await Promise.all([
      check(db().from("friendships").select("b, created_at, a_seen").eq("a", me).limit(1000), "list"),
      check(db().from("friendships").select("a, created_at, b_seen").eq("b", me).limit(1000), "list"),
      check(db().from("friend_requests").select("id, from_account, to_account, created_at, declined_at").eq("to_account", me).limit(1000), "list"),
      check(db().from("friend_requests").select("id, from_account, to_account, created_at, declined_at").eq("from_account", me).limit(1000), "list"),
      check(db().from("friend_challenges").select("match_id, from_account, created_at").eq("to_account", me).gt("created_at", iso(now - 2 * 86_400_000)).limit(200), "list"),
    ]);
    type Req = { id: string; from_account: string; to_account: string; created_at: string; declined_at: string | null };
    const row = (r: Req) => ({ id: r.id, from: r.from_account, to: r.to_account, at: Date.parse(r.created_at), declinedAt: ms(r.declined_at) });
    const friends = [
      ...(fa as { b: string; created_at: string; a_seen: boolean }[]).map((f) => ({ account: f.b, since: Date.parse(f.created_at), isNew: !f.a_seen })),
      ...(fb as { a: string; created_at: string; b_seen: boolean }[]).map((f) => ({ account: f.a, since: Date.parse(f.created_at), isNew: !f.b_seen })),
    ];
    const friendSet = new Set(friends.map((f) => f.account));
    return {
      friends,
      incoming: (inc as Req[]).map(row).filter((r) => isWaiting(r, now)).map((r) => ({ account: r.from, at: r.at })),
      outgoing: (out as Req[]).map(row).filter((r) => showsAsSent(r, now)).map((r) => ({ account: r.to, at: r.at })),
      challenges: (ch as { match_id: string; from_account: string; created_at: string }[])
        .filter((c) => friendSet.has(c.from_account))
        .map((c) => ({ matchId: c.match_id, from: c.from_account, at: Date.parse(c.created_at) })),
    };
  },
  async markSeen(me) {
    await Promise.all([
      check(db().from("friendships").update({ a_seen: true }).eq("a", me).eq("a_seen", false), "seen"),
      check(db().from("friendships").update({ b_seen: true }).eq("b", me).eq("b_seen", false), "seen"),
    ]);
  },
  async createSession(tokenHash, s: FriendsSession, nonce) {
    const { error } = await db()
      .from("friend_sessions")
      .insert({ token_hash: tokenHash, account: s.account, authority: s.authority, privy_sub: s.privySub, nonce, expires_at: iso(s.expiresAt) });
    if (error?.code === "23505") return false;
    if (error) throw new Error(`Friends session save failed: ${error.message}`);
    return true;
  },
  async getSession(tokenHash, now) {
    const row = await check(db().from("friend_sessions").select("account, authority, privy_sub, expires_at").eq("token_hash", tokenHash).maybeSingle(), "session read");
    const r = row as { account: string; authority: string; privy_sub: string | null; expires_at: string } | null;
    if (!r || Date.parse(r.expires_at) <= now) return null;
    return { account: r.account, authority: r.authority, privySub: r.privy_sub, expiresAt: Date.parse(r.expires_at) };
  },
  async deleteSession(tokenHash) {
    await check(db().from("friend_sessions").delete().eq("token_hash", tokenHash), "session delete");
  },
};
