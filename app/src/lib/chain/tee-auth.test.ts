import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeeUnreachableError, guardedFetch, resetTeeAuth, teeToken, type TeeAuthDeps } from "./tee-auth";

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

  it("treats HTTP 429 as a ban and a normal answer as fine", async () => {
    const inner = vi.fn().mockResolvedValueOnce(new Response("slow down", { status: 429 })).mockResolvedValue(new Response("{}", { status: 200 }));
    const f = guardedFetch(RPC, inner as unknown as typeof fetch);
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    await expect(f(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(inner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await f(RPC, {})).status).toBe(200);
  });

  it("login and rollup share one pause", async () => {
    const login = vi.fn(async () => {
      throw new Error("429 too many requests");
    });
    await expect(teeToken(RPC, pk, sign, deps(login))).rejects.toBeInstanceOf(TeeUnreachableError);
    const inner = vi.fn(async () => new Response("{}"));
    await expect(guardedFetch(RPC, inner as unknown as typeof fetch)(RPC, {})).rejects.toBeInstanceOf(TeeUnreachableError);
    expect(inner).not.toHaveBeenCalled();
  });
});
