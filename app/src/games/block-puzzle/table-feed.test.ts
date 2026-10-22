import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, type AccountInfo } from "@solana/web3.js";
import { watchAccount, type FeedConnection } from "./table-feed";

const info = (n: number) => ({ data: Buffer.from([n]), owner: Keypair.generate().publicKey, lamports: 0, executable: false }) as AccountInfo<Buffer>;

function conn() {
  let push: ((i: AccountInfo<Buffer>) => void) | null = null;
  let reads = 0;
  let value = 0;
  const removed: number[] = [];
  const c: FeedConnection = {
    getAccountInfo: async () => {
      reads++;
      return info(value);
    },
    onAccountChange: (_a, cb) => {
      push = cb;
      return 7;
    },
    removeAccountChangeListener: async (id) => void removed.push(id),
  };
  return { c, push: (n: number) => push?.(info(n)), reads: () => reads, set: (n: number) => (value = n), removed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const address = Keypair.generate().publicKey;

describe("watchAccount (the table feed)", () => {
  it("delivers what the websocket pushes", async () => {
    const k = conn();
    const got: number[] = [];
    watchAccount({ conn: k.c, address, decode: (i) => i.data[0], onValue: (v) => got.push(v), now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    k.push(5);
    k.push(6);
    expect(got.slice(-2)).toEqual([5, 6]);
  });

  it("reads once at the start so the screen has something before the first push", async () => {
    const k = conn();
    k.set(3);
    const got: number[] = [];
    watchAccount({ conn: k.c, address, decode: (i) => i.data[0], onValue: (v) => got.push(v), now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([3]);
  });

  it("does not read while the websocket keeps talking", async () => {
    const k = conn();
    watchAccount({ conn: k.c, address, decode: (i) => i.data[0], onValue: () => undefined, pollMs: 1000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    const after = k.reads();
    for (let t = 0; t < 4; t++) {
      await vi.advanceTimersByTimeAsync(400);
      k.push(t);
    }
    expect(k.reads()).toBe(after);
  });

  it("falls back to reading when the socket has been silent for the poll period", async () => {
    const k = conn();
    const got: number[] = [];
    watchAccount({ conn: k.c, address, decode: (i) => i.data[0], onValue: (v) => got.push(v), pollMs: 1000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    k.set(9);
    await vi.advanceTimersByTimeAsync(1600);
    expect(got).toContain(9);
  });

  it("stops: no more values, and the subscription is removed", async () => {
    const k = conn();
    const got: number[] = [];
    const stop = watchAccount({ conn: k.c, address, decode: (i) => i.data[0], onValue: (v) => got.push(v), pollMs: 1000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const n = got.length;
    k.push(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(got.length).toBe(n);
    expect(k.removed).toEqual([7]);
  });

  it("a value that does not decode (not the table) is ignored", async () => {
    const k = conn();
    const got: number[] = [];
    watchAccount({ conn: k.c, address, decode: () => null, onValue: (v: number) => got.push(v), now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    k.push(1);
    expect(got).toEqual([]);
  });
});
