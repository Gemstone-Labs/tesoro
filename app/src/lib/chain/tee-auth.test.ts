import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeeLoginError, TeeUnreachableError, teeLogin, clearTeeTokens, guardedFetch, invalidateTeeToken, resetTeeAuth, teeToken, type TeeAuthDeps } from "./tee-auth";

const RPC = "https://tee.test";
const pk = new PublicKey("11111111111111111111111111111112");
const sign = async (m: Uint8Array) => m;
const ok = (n = 1) => ({ token: `tok${n}`, expiresAt: Date.now() + 24 * 3600_000 });

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const deps = (login: TeeAuthDeps["login"], store = memStore()): TeeAuthDeps => ({ login, store });

beforeEach(() => {
  vi.useFakeTimers();
  resetTeeAuth();
});
afterEach(() => vi.useRealTimers());

describe("teeToken", () => {
  it("logs in once for concurrent callers", async () => {
    const login = vi.fn(async () => ok());
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => teeToken(RPC, pk, sign, deps(login))));
    expect(login).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((t) => t.token)).size).toBe(1);
  });

  it("reuses the token until it expires, across a reload", async () => {
    const store = memStore();
    const login = vi.fn(async () => ok());
    await teeToken(RPC, pk, sign, deps(login, store));
    resetTeeAuth(); // a reload keeps only the store
    await teeToken(RPC, pk, sign, deps(login, store));
    expect(login).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    resetTeeAuth();
    await teeToken(RPC, pk, sign, deps(login, store));
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("backs off on a ban instead of hammering", async () => {
    const login = vi.fn(async () => {
      throw new Error('Failed to authenticate: {"code":-32005,"message":"client temporarily banned"}');
    });
    const d = deps(login);
    await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(2);
    // the pause grows
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("a rate-limited login pauses for seconds, not a minute", async () => {
    const login = vi.fn(async () => {
      throw new Error("429 too many requests");
    });
    const d = deps(login);
    await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(teeToken(RPC, pk, sign, d)).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure a few times with growing waits, then stops", async () => {
    const login = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const p = teeToken(RPC, pk, sign, deps(login)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(3);
  });

  it("recovers after a transient failure", async () => {
    const login = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue(ok());
    const p = teeToken(RPC, pk, sign, deps(login));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).token).toBe("tok1");
  });

  it("does not retry when the Player cancels the signature", async () => {
    const login = vi.fn(async () => {
      throw Object.assign(new Error("User rejected the request"), { code: 4001 });
    });
    await expect(teeToken(RPC, pk, sign, deps(login))).rejects.toThrow(/rejected/);
    expect(login).toHaveBeenCalledTimes(1);
    await expect(teeToken(RPC, pk, sign, deps(login))).rejects.toThrow(/rejected/);
    expect(login).toHaveBeenCalledTimes(2);
  });
});

describe("guardedFetch", () => {
  it("pauses every rollup call after a banned answer, without touching the network", async () => {
    const inner = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32005, message: "client temporarily banned" }, id: 1 }), { status: 200 }));
    const f = guardedFetch(RPC, inner as unknown as typeof fetch);
    await f(RPC, {});
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(inner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await f(RPC, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("treats HTTP 429 as a short rate limit, not a ban", async () => {
    const inner = vi.fn().mockResolvedValueOnce(new Response("slow down", { status: 429 })).mockResolvedValue(new Response("{}", { status: 200 }));
    const f = guardedFetch(RPC, inner as unknown as typeof fetch);
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(inner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await f(RPC, {})).status).toBe(200);
  });

  it("a 401 drops the token once; the next caller logs in fresh, and a late 401 from the old token does not drop the new one", async () => {
    const store = memStore();
    let n = 0;
    const login = vi.fn(async () => ok(++n));
    const d = deps(login, store);
    const old = await teeToken(RPC, pk, sign, d);
    invalidateTeeToken(RPC, pk, store, old.token);
    const fresh = await teeToken(RPC, pk, sign, d);
    expect(fresh.token).toBe("tok2");
    expect(login).toHaveBeenCalledTimes(2);
    invalidateTeeToken(RPC, pk, store, old.token); // late 401 from the old connection
    expect((await teeToken(RPC, pk, sign, d)).token).toBe("tok2");
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("sign-out clears every stored token and nothing else", async () => {
    const m = new Map<string, string>([["other", "x"]]);
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
    const login = vi.fn(async () => ok());
    await teeToken(RPC, pk, sign, deps(login, store));
    clearTeeTokens(store);
    expect([...m.keys()]).toEqual(["other"]);
    await teeToken(RPC, pk, sign, deps(login, store));
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("keeps one token per wallet", async () => {
    const other = new PublicKey("11111111111111111111111111111113");
    const store = memStore();
    let n = 0;
    const login = vi.fn(async () => ok(++n));
    const a = await teeToken(RPC, pk, sign, deps(login, store));
    const b = await teeToken(RPC, other, sign, deps(login, store));
    expect(a.token).not.toBe(b.token);
    resetTeeAuth();
    expect((await teeToken(RPC, pk, sign, deps(login, store))).token).toBe(a.token);
    expect((await teeToken(RPC, other, sign, deps(login, store))).token).toBe(b.token);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("login and rollup share one pause", async () => {
    const login = vi.fn(async () => {
      throw new Error("Failed to authenticate: client temporarily banned -32005");
    });
    await expect(teeToken(RPC, pk, sign, deps(login))).rejects.toBeInstanceOf(TeeUnreachableError);
    const inner = vi.fn(async () => new Response("{}"));
    await expect(guardedFetch(RPC, inner as unknown as typeof fetch)(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("ban detection with the real error shapes", () => {
  it("the SDK's stringified object error counts as a ban (no retry loop)", async () => {
    const login = vi.fn(async () => {
      throw new Error(`Failed to authenticate: ${{ code: -32005, message: "client temporarily banned" }}`); // "[object Object]"
    });
    await expect(teeToken(RPC, pk, sign, deps(login))).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("teeLogin keeps the server's JSON-RPC ban answer and takes the long pause", async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/challenge")) return new Response(JSON.stringify({ challenge: "hello" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: -32005, message: "client temporarily banned" } }), { status: 403 });
    });
    vi.stubGlobal("fetch", f);
    try {
      await expect(teeLogin(RPC, pk, sign)).rejects.toMatchObject({ name: "TeeLoginError", status: 403, body: expect.stringContaining("-32005") });
      f.mockClear();
      const d: TeeAuthDeps = { store: memStore() };
      const t0 = Date.now();
      const err = await teeToken(RPC, pk, sign, d).catch((e) => e);
      expect(err).toBeInstanceOf(TeeUnreachableError);
      expect(err.retryAt - t0).toBeGreaterThanOrEqual(48_000);
      expect(f).toHaveBeenCalledTimes(2); // one challenge + one login, no retry
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a ban on the challenge step is a ban too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: -32005, message: "client temporarily banned" } }), { status: 403 })));
    try {
      const err = await teeToken(RPC, pk, sign, { store: memStore() }).catch((e) => e);
      expect(err).toBeInstanceOf(TeeUnreachableError);
      expect(err.retryAt - Date.now()).toBeGreaterThan(40_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("any other failure backs off: 3 tries, then a pause with no network", async () => {
    const login = vi.fn(async () => {
      throw new TeeLoginError("login", 500, "boom");
    });
    const d = deps(login);
    const p = teeToken(RPC, pk, sign, d).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await p).toBeInstanceOf(TeeUnreachableError);
    expect(login).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 20; i++) await teeToken(RPC, pk, sign, d).catch(() => {});
    expect(login).toHaveBeenCalledTimes(3);
  });
});
