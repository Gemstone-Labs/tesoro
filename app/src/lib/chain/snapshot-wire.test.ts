import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeState, encodeState, fetchRoutedState } from "./snapshot-wire";
import type { AccountSnapshot } from "./read";

const key = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const snapshot = { exists: true, accountKey: key, lamports: 5, ownTotal: 2n ** 63n, holdings: [{ free: 7n, source: key }], market: null } as unknown as AccountSnapshot;

describe("Account state on the wire", () => {
  it("round-trips bigints and keys through JSON", () => {
    const text = JSON.stringify(encodeState(snapshot));
    expect(text).toContain('"9223372036854775808"');
    const back = decodeState<AccountSnapshot>(JSON.parse(text));
    expect(back.ownTotal).toBe(2n ** 63n);
    expect(back.accountKey.equals(key)).toBe(true);
    expect(back.holdings[0].free).toBe(7n);
    expect(back.market).toBeNull();
  });
});

describe("the browser's read of the route", () => {
  const answer = (status: number, body: unknown = encodeState(snapshot)) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("returns the route's state, stamped when the browser got it", async () => {
    const snap = await fetchRoutedState(key, { fetch: answer(200) });
    expect(snap?.ownTotal).toBe(2n ** 63n);
    expect(snap?.fetchedAt).toBeGreaterThan(0);
  });

  it("asks for fresh lists after a transaction", async () => {
    let url = "";
    await fetchRoutedState(key, { fresh: true, fetch: (async (u: string) => ((url = u), Response.json(encodeState(snapshot)))) as unknown as typeof fetch });
    expect(url).toBe(`/api/account/${key.toBase58()}?fresh=1`);
  });

  it("gives up (null) on an error status, a network error, a bad body and a hung request", async () => {
    expect(await fetchRoutedState(key, { fetch: answer(502, { error: "x" }) })).toBeNull();
    expect(await fetchRoutedState(key, { fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch })).toBeNull();
    expect(await fetchRoutedState(key, { fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch })).toBeNull();
    const hung = ((_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timeout"))))) as unknown as typeof fetch;
    expect(await fetchRoutedState(key, { fetch: hung, timeoutMs: 20 })).toBeNull();
  });
});
