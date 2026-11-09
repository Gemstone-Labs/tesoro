import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import { BurstDriver, type BurstDriverDeps } from "./burst-driver";
import { blankTable, fixtureKey } from "./live-fixtures";

const finished: string[] = [];
vi.mock("@/lib/chain/finish-match-client", () => ({
  finishMatchFree: async (_s: unknown, _t: unknown, address: { toBase58(): string }) => {
    finished.push(address.toBase58());
    return { done: false, stage: "refunding", signatures: [] };
  },
  finalizeAndFinishFree: async () => ({ done: false, signatures: [] }),
}));

const opener = fixtureKey(2);
const matchKey = `${fixtureKey(7).toBase58()}-0`;

beforeEach(() => {
  finished.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BurstDriver, a Match its opener cancelled (ticket 61)", () => {
  // 3Cyp…-5 on 2026-11-09: refund_match landed (Refunding, nobody joined, no table) and no page ran the chunks; the sweep did, 17 min later.
  const cancelled = { id: matchKey, status: "active", running: "refunding", seat: 0, backerSeat: null, deadline: 4_000_000_000, entry: 500, opponent: null, sides: [{}] } as unknown as ChainMatch;

  it("runs the chunks and the close itself, so the entry comes back at once", async () => {
    const chain = { readAssignment: async () => null, readTable: async () => blankTable(), readTableOnBase: async () => null, watchTable: async () => () => undefined } as unknown as BurstDriverDeps["chain"];
    const signer = { publicKey: opener, signTransaction: async (t: never) => t, signMessage: async () => new Uint8Array(64) };
    const d = new BurstDriver({ id: matchKey, signer: signer as never, accountKey: null, getToken: async () => null, chain, fetchMatch: async () => cancelled });
    d.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(d.view.stage).toBe("cancelling");
    expect(finished.length).toBeGreaterThan(0);
    d.stop();
  });
});
