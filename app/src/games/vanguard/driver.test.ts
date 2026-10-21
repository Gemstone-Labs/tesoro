import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { actionsDue, canDelegate, contributeBundled, readDue, tickDelayMs } from "./driver";
import { STATUS, type Battle } from "./decode";

const battle = (over: Partial<Battle> = {}): Battle => ({ status: STATUS.live, startDeadline: 1000, pendingKind: 0, turnSecs: 10, graceSecs: 1, openingGraceSecs: 10, ...over }) as Battle;

describe("a Battle is delegated only inside its start window", () => {
  it("allows the last second and refuses the next", () => {
    expect(canDelegate(battle({ startDeadline: 1000 }), 1000)).toBe(true);
    expect(canDelegate(battle({ startDeadline: 1000 }), 1001)).toBe(false);
  });
});

describe("the second contributor asks for the randomness in the same transaction", () => {
  const p = {} as never;
  const q = new PublicKey("SysvarRent111111111111111111111111111111111");
  it("sends one bundled transaction when it is the second", async () => {
    const vg = { contributeEntropy: vi.fn().mockResolvedValue("sig") };
    await contributeBundled(vg, p, 7n, q);
    expect(vg.contributeEntropy.mock.calls).toEqual([[p, 7n, true, q]]);
  });

  it("falls back to a plain contribution when the other secret is not in yet", async () => {
    const vg = { contributeEntropy: vi.fn().mockRejectedValueOnce(new Error("EntropyIncomplete")).mockResolvedValue("sig") };
    await contributeBundled(vg, p, 7n, q);
    expect(vg.contributeEntropy.mock.calls.map((c) => c[2])).toEqual([true, false]);
  });

  it("treats an already-counted contribution as done and rethrows anything else", async () => {
    const done = { contributeEntropy: vi.fn().mockRejectedValue(new Error("AlreadyContributed")) };
    await expect(contributeBundled(done, p, 7n)).resolves.toBeUndefined();
    const broken = { contributeEntropy: vi.fn().mockRejectedValue(new Error("network down")) };
    await expect(contributeBundled(broken, p, 7n)).rejects.toThrow("network down");
  });
});

describe("reads while the Battle subscription is working", () => {
  it("polls only when nothing arrived or was read for the fallback period", () => {
    expect(readDue(10_000, 9_000, 0)).toBe(false);
    expect(readDue(10_000, 0, 6_000)).toBe(false);
    expect(readDue(10_000, 0, 0)).toBe(true);
    expect(readDue(10_000, 4_999, 4_999)).toBe(true);
  });

  it("slows the driver down while the Match is live", () => {
    expect(tickDelayMs("live")).toBeGreaterThanOrEqual(5_000);
    expect(tickDelayMs("setup")).toBeLessThan(2_000);
  });
});

describe("what a client sends from the Battle it already holds", () => {
  it("resolves a pending action, at most every 600 ms", () => {
    const b = battle({ pendingKind: 1 });
    expect(actionsDue(b, 0, 10_000, 0, 0).resolve).toBe(true);
    expect(actionsDue(b, 0, 10_000, 9_700, 0).resolve).toBe(false);
    expect(actionsDue(battle(), 0, 10_000, 0, 0).resolve).toBe(false);
  });

  it("claims a timeout only once the clock says it is due, at most every 2.5 s", () => {
    const seen = 1_000_000_000_000;
    const b = battle({ startedAt: seen / 1000, turnNo: 2, moves: 5 });
    expect(actionsDue(b, seen, seen + 1_000, 0, 0).claim).toBe(false);
    expect(actionsDue(b, seen, seen + 20_000, 0, 0).claim).toBe(true);
    expect(actionsDue(b, seen, seen + 20_000, 0, seen + 19_000).claim).toBe(false);
  });
});
