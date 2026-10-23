import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { accountKeyOf } from "../../lib/chain/account-key";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { MAX_FRIENDS, MAX_OUTGOING, pairOf } from "./rules";
import { handleFriends, requestIsHttps, startSession, type FriendNotice, type FriendsDeps, type OpenChallenge } from "./routes";
import { MemoryFriendsStore } from "./store";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const ORIGIN = { origin: "https://www.playtesoro.com", host: "www.playtesoro.com" };

function signed(kp: Keypair, at = NOW) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-friends", "session", address, at, nonce, {})), kp.secretKey);
  return { step: "session", address, ts: at, nonce, signature: Buffer.from(sig).toString("base64") };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

function world(opts: { env?: AuthEnv } = {}) {
  const store = new MemoryFriendsStore();
  const notices: FriendNotice[] = [];
  const open = new Map<string, OpenChallenge>();
  let now = NOW;
  let tokens = 0;
  const deps: FriendsDeps = {
    store,
    now: () => now,
    env: opts.env ?? dev,
    openChallenge: async (id) => open.get(id) ?? null,
    notify: async (n) => void notices.push(n),
    newToken: () => `token-${++tokens}`,
  };
  const player = async (authorization: string | null = null) => {
    const kp = Keypair.generate();
    const s = await startSession(deps, signed(kp, now), authorization);
    const call = (body: Record<string, unknown>, ctx: Partial<{ token: string | null; authorization: string | null; origin: string | null }> = {}) =>
      handleFriends(deps, body, { token: s.token, authorization, ...ORIGIN, ...ctx }).then((r) => r.result as Record<string, any>);
    return { kp, account: s.account, token: s.token, call };
  };
    /** Moves the clock; sessions stay valid unless `expireSessions`. */
  const advance = (ms: number, expireSessions = false) => {
    now += ms;
    if (!expireSessions) for (const x of store.sessions.values()) x.expiresAt += ms;
  };
  return { store, notices, open, deps, player, advance };
}

/** A Match key: the opener's Account and its counter value. */
const mk = (n: number) => `${"1".repeat(32)}-${n}`;

describe("Friends session", () => {
  it("starts from one signature and names the Account, not the wallet", async () => {
    const w = world();
    const a = await w.player();
    expect(a.account).toBe(accountKeyOf(a.kp.publicKey.toBase58()));
    expect((await a.call({ op: "list" })).friends).toEqual([]);
  });

  it("refuses a forged, missing or expired session cookie", async () => {
    const w = world();
    const a = await w.player();
    expect(await code(a.call({ op: "list" }, { token: "token-999" }))).toBe("no-session");
    expect(await code(a.call({ op: "list" }, { token: null }))).toBe("no-session");
    w.advance(31 * DAY, true);
    expect(await code(a.call({ op: "list" }))).toBe("no-session");
  });

  it("refuses a request from another site or with no Origin", async () => {
    const w = world();
    const a = await w.player();
    expect(await code(a.call({ op: "list" }, { origin: "https://evil.example" }))).toBe("bad-origin");
    expect(await code(a.call({ op: "list" }, { origin: null }))).toBe("bad-origin");
  });

  it("refuses a replayed session signature, even on a server that never saw it", async () => {
    const w = world();
    const kp = Keypair.generate();
    const body = signed(kp);
    await startSession(w.deps, body, null);
    expect(await code(startSession(w.deps, body, null))).toBe("replayed");
    // Another instance: its own in-memory nonces are empty, the stored nonce still refuses it.
    expect(await w.store.createSession("x", { account: "a", authority: "a", privySub: null, expiresAt: NOW + DAY }, body.nonce)).toBe(false);
  });

  it("refuses a wrong-wallet signature", async () => {
    const w = world();
    const body = { ...signed(Keypair.generate()), address: Keypair.generate().publicKey.toBase58() };
    expect(await code(startSession(w.deps, body, null))).toBe("bad-signature");
  });

  it("ends when the Privy sign-in is gone or belongs to someone else", async () => {
    const subs: Record<string, string> = { "tok-a": "did:privy:a", "tok-b": "did:privy:b" };
    const env: AuthEnv = { production: true, devWallet: false, privyAppId: "app", verifyToken: async (t) => subs[t] ?? null };
    const w = world({ env });
    const a = await w.player("Bearer tok-a");
    expect((await a.call({ op: "list" })).friends).toEqual([]);
    expect(await code(a.call({ op: "list" }, { authorization: "Bearer tok-b" }))).toBe("no-session");
    expect(await code(a.call({ op: "list" }, { authorization: null }))).toBe("no-session");
  });

  it("signs out", async () => {
    const w = world();
    const a = await w.player();
    await a.call({ op: "sign-out" });
    expect(await code(a.call({ op: "list" }))).toBe("no-session");
  });
});

describe("Friend requests", () => {
  it("become a friendship when accepted; the sender sees the new Friend until they look", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    expect(w.notices).toEqual([{ kind: "friend-request", id: "friend-request:r1", to: b.account }]);
    const bv = await b.call({ op: "list" });
    expect(bv.incoming.map((r: any) => r.account)).toEqual([a.account]);
    expect(bv.badge).toBe(1);
    expect((await a.call({ op: "list" })).outgoing.map((r: any) => r.account)).toEqual([b.account]);

    expect(await b.call({ op: "accept", from: a.account })).toEqual({ status: "friends" });
    const av = await a.call({ op: "list" });
    expect(av.friends).toEqual([{ account: b.account, since: NOW, isNew: true }]);
    expect(av.badge).toBe(1);
    expect((await b.call({ op: "list" })).friends[0].isNew).toBe(false);
    await a.call({ op: "seen" });
    expect((await a.call({ op: "list" })).badge).toBe(0);
  });

  it("takes a wallet address for the other Player and maps it to their Account", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.kp.publicKey.toBase58() });
    expect((await b.call({ op: "list" })).incoming[0].account).toBe(a.account);
  });

  it("refuses yourself and repeats", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    expect(await a.call({ op: "request", to: a.account })).toEqual({ status: "self" });
    await a.call({ op: "request", to: b.account });
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    expect(w.notices).toHaveLength(1);
    await b.call({ op: "accept", from: a.account });
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "already-friends" });
  });

  it("crossing requests make Friends at once", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    expect(await b.call({ op: "request", to: a.account })).toEqual({ status: "friends" });
    expect((await a.call({ op: "list" })).friends.map((f: any) => f.account)).toEqual([b.account]);
    expect((await a.call({ op: "list" })).incoming).toEqual([]);
  });

  it("a decline is silent: the sender still sees Request sent, can't re-send for 30 days, then can", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    await b.call({ op: "decline", from: a.account });
    expect((await b.call({ op: "list" })).incoming).toEqual([]);
    expect((await a.call({ op: "list" })).outgoing.map((r: any) => r.account)).toEqual([b.account]);
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    expect(w.notices).toHaveLength(1);
    // A declined request is not one B can accept, and it doesn't turn B's own request into a friendship.
    expect(await b.call({ op: "accept", from: a.account })).toEqual({ status: "gone" });
    w.advance(31 * DAY);
    expect((await a.call({ op: "list" })).outgoing).toEqual([]);
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    expect(w.notices).toHaveLength(2);
    expect(w.notices[1].id).not.toBe(w.notices[0].id);
  });

  it("a request nobody answers is gone after 30 days", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    w.advance(31 * DAY);
    expect((await b.call({ op: "list" })).incoming).toEqual([]);
    expect(await b.call({ op: "accept", from: a.account })).toEqual({ status: "gone" });
  });

  it("Remove is silent, for both, and clears an old decline", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    await b.call({ op: "accept", from: a.account });
    await b.call({ op: "remove", account: a.account });
    expect((await a.call({ op: "list" })).friends).toEqual([]);
    expect((await b.call({ op: "list" })).friends).toEqual([]);
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    await b.call({ op: "decline", from: a.account });
    await a.call({ op: "remove", account: b.account });
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });
    expect((await b.call({ op: "list" })).incoming.map((r: any) => r.account)).toEqual([a.account]);
  });

  it("caps Friends at 500 and waiting requests at 50", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    for (let i = 0; i < MAX_OUTGOING; i++) await w.store.request(a.account, `X${i}`, NOW);
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "request-cap" });
    await w.store.remove(a.account, "X0");
    expect(await a.call({ op: "request", to: b.account })).toEqual({ status: "sent" });

    for (let i = 0; i < MAX_FRIENDS; i++) {
      const [x, y] = pairOf(b.account, `F${i}`);
      w.store.friendships.set(`${x}|${y}`, { a: x, b: y, since: NOW, aSeen: true, bSeen: true });
    }
    expect(await b.call({ op: "accept", from: a.account })).toEqual({ status: "friend-cap" });
    expect(await a.call({ op: "list" }).then((v) => v.friends)).toEqual([]);
  });
});

describe("Friend links", () => {
  it("one tap makes Friends; the owner sees the new Friend; reset ends the old link", async () => {
    const w = world();
    const [a, b, c] = [await w.player(), await w.player(), await w.player()];
    const { code: link } = await a.call({ op: "link" });
    expect((await a.call({ op: "link" })).code).toBe(link);
    expect(await a.call({ op: "redeem", code: link })).toEqual({ status: "own", owner: a.account });
    expect(await b.call({ op: "redeem", code: link })).toEqual({ status: "friends", owner: a.account });
    expect(await b.call({ op: "redeem", code: link })).toEqual({ status: "already-friends", owner: a.account });
    expect((await a.call({ op: "list" })).friends).toEqual([{ account: b.account, since: NOW, isNew: true }]);
    const { code: fresh } = await a.call({ op: "reset-link" });
    expect(fresh).not.toBe(link);
    expect(await c.call({ op: "redeem", code: link })).toEqual({ status: "gone" });
    expect(await c.call({ op: "redeem", code: "not a code" })).toEqual({ status: "gone" });
  });

  it("limits how many links one Account opens in a day", async () => {
    const w = world();
    const a = await w.player();
    for (let i = 0; i < 20; i++) await a.call({ op: "redeem", code: "1111111111" });
    expect(await code(a.call({ op: "redeem", code: "1111111111" }))).toBe("too-many");
  });
});

describe("friend Challenges", () => {
  const friends = async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    await b.call({ op: "accept", from: a.account });
    w.notices.length = 0;
    return { w, a, b };
  };

  it("records only an open Challenge the sender opened, for a Friend, and shows it while it is open", async () => {
    const { w, a, b } = await friends();
    w.open.set(mk(11), { game: "holdem", entry: 500, opener: b.account });
    expect(await code(a.call({ op: "challenge", matchId: mk(11), to: b.account }))).toBe("not-your-challenge");
    expect(await code(a.call({ op: "challenge", matchId: mk(13), to: b.account }))).toBe("not-your-challenge");
    w.open.set(mk(13), { game: "holdem", entry: 500, opener: a.account });
    const stranger = await w.player();
    expect(await a.call({ op: "challenge", matchId: mk(13), to: stranger.account })).toEqual({ status: "not-friends" });
    expect(await a.call({ op: "challenge", matchId: mk(13), to: b.account })).toEqual({ status: "recorded" });
    expect(await a.call({ op: "challenge", matchId: mk(13), to: b.account })).toEqual({ status: "duplicate" });
    expect(w.notices).toEqual([{ kind: "friend-challenge", id: `friend-challenge:${mk(13)}`, to: b.account, matchId: mk(13), game: "holdem", entry: 500 }]);
    const bv = await b.call({ op: "list" });
    expect(bv.challenges).toEqual([{ matchId: mk(13), from: a.account, at: NOW, game: "holdem", entry: 500 }]);
    expect(bv.badge).toBe(1);
    w.open.delete(mk(13)); // joined, or refunded
    expect((await b.call({ op: "list" })).challenges).toEqual([]);
  });

  it("emails a Friend at most 3 Challenges a day and caps a sender at 10 a day", async () => {
    const { w, a, b } = await friends();
    const c = await w.player();
    await a.call({ op: "request", to: c.account });
    await c.call({ op: "accept", from: a.account });
    w.notices.length = 0;
    for (let i = 0; i < 10; i++) {
      const id = mk(101 + 2 * i);
      w.open.set(id, { game: "block-puzzle", entry: 500, opener: a.account });
      expect(await a.call({ op: "challenge", matchId: id, to: i < 5 ? b.account : c.account })).toEqual({ status: "recorded" });
    }
    expect(w.notices.filter((n) => n.to === b.account)).toHaveLength(3);
    expect(w.notices.filter((n) => n.to === c.account)).toHaveLength(3);
    w.open.set(mk(999), { game: "block-puzzle", entry: 500, opener: a.account });
    expect(await a.call({ op: "challenge", matchId: mk(999), to: b.account })).toEqual({ status: "challenge-cap" });
  });

  it("drops Challenges from someone who is no longer a Friend", async () => {
    const { w, a, b } = await friends();
    w.open.set(mk(15), { game: "holdem", entry: 500, opener: a.account });
    await a.call({ op: "challenge", matchId: mk(15), to: b.account });
    await b.call({ op: "remove", account: a.account });
    expect((await b.call({ op: "list" })).challenges).toEqual([]);
  });
});

describe("request checks", () => {
  it("refuses a Match id that is not a u64", async () => {
    const w = world();
    const a = await w.player();
    expect(await code(a.call({ op: "challenge", matchId: "99999999999999999999", to: a.account }))).toBe("bad-request");
    expect(await code(a.call({ op: "challenge", matchId: "12a", to: a.account }))).toBe("bad-request");
  });

  it("reads every listed Challenge in one batch when it can", async () => {
    const w = world();
    const [a, b] = [await w.player(), await w.player()];
    await a.call({ op: "request", to: b.account });
    await b.call({ op: "accept", from: a.account });
    w.open.set(mk(21), { game: "holdem", entry: 500, opener: a.account });
    w.open.set(mk(23), { game: "holdem", entry: 500, opener: a.account });
    await a.call({ op: "challenge", matchId: mk(21), to: b.account });
    await a.call({ op: "challenge", matchId: mk(23), to: b.account });
    const batches: string[][] = [];
    w.deps.openChallenges = async (ids) => (batches.push(ids), ids.map((id) => w.open.get(id) ?? null));
    expect((await b.call({ op: "list" })).challenges.map((c: { matchId: string }) => c.matchId).sort()).toEqual([mk(21), mk(23)]);
    expect(batches).toHaveLength(1);
  });

  it("knows HTTPS from the proxy header or the URL", () => {
    expect(requestIsHttps(new Request("http://x/api", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(requestIsHttps(new Request("https://x/api"))).toBe(true);
    expect(requestIsHttps(new Request("http://localhost:3381/api"))).toBe(false);
  });
});
