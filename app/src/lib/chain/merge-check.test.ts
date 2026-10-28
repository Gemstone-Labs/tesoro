import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { checkForOlder, type MergeIo, type QueueMerge } from "./merge-check";
import type { ChainMatch } from "./read";

const mine = (over: Partial<ChainMatch> = {}) =>
  ({ id: "ben-0", status: "open", seat: 0, challenge: false, opponent: null, backing: null, backerSeat: null, address: PublicKey.default, ...over }) as ChainMatch;

function io(over: Partial<MergeIo> = {}) {
  const phases: QueueMerge[] = [];
  const navigated: string[] = [];
  const base: MergeIo = {
    fetchMine: async () => mine(),
    merge: vi.fn(async (_m: ChainMatch, on: { onMove(): void }) => {
      on.onMove();
      return { moved: true as const, entered: { id: "alice-0", via: "joined" as const } };
    }),
    set: (s) => phases.push(s),
    navigate: (id) => navigated.push(id),
    stillHere: () => true,
    ...over,
  };
  return { base, phases, navigated };
}

describe("checkForOlder", () => {
  it("shows 'moving' and then goes straight to the Match joined, without a refunded screen in between", async () => {
    const t = io();
    await checkForOlder(t.base);
    expect(t.phases.map((p) => p.phase)).toEqual(["moving"]);
    expect(t.navigated).toEqual(["alice-0"]);
  });

  it("does nothing for a Challenge, a paired Match, or a Match that is gone", async () => {
    for (const m of [mine({ challenge: true }), mine({ status: "active", opponent: "dan" }), null]) {
      const t = io({ fetchMine: async () => m });
      await checkForOlder(t.base);
      expect(t.base.merge).not.toHaveBeenCalled();
      expect(t.phases).toEqual([]);
    }
  });

  it("returns to idle when no older Match was taken", async () => {
    const t = io({ merge: vi.fn(async () => ({ moved: false as const })) });
    await checkForOlder(t.base);
    // Never showed "moving": the older Player checks every few seconds and must not flicker.
    expect(t.phases.map((p) => p.phase)).toEqual(["idle"]);
    expect(t.navigated).toEqual([]);
  });

  it("a move that stops half way shows the error instead of a blank page", async () => {
    const t = io({
      merge: vi.fn(async () => {
        throw new Error("Your entry was sent but Solana has not confirmed it yet.");
      }),
    });
    await checkForOlder(t.base);
    expect(t.phases.at(-1)).toEqual({ phase: "failed", error: "Your entry was sent but Solana has not confirmed it yet." });
  });

  it("does not navigate when the Player already left the page", async () => {
    const t = io({ stillHere: () => false });
    await checkForOlder(t.base);
    expect(t.navigated).toEqual([]);
  });
});

describe("checkForOlder, when to stop looking", () => {
  it("says the Match can never move again once it is paired, a Challenge or Backed", async () => {
    for (const m of [mine({ challenge: true }), mine({ status: "active", opponent: "dan" }), mine({ backerSeat: 1 })]) {
      expect(await checkForOlder(io({ fetchMine: async () => m }).base)).toBe("over");
    }
  });
  it("keeps looking while the Match is still alone, or could not be read", async () => {
    expect(await checkForOlder(io({ fetchMine: async () => mine(), merge: async () => ({ moved: false as const }) }).base)).toBe("keep");
    expect(await checkForOlder(io({ fetchMine: async () => null }).base)).toBe("keep");
  });
  it("is over once the Player has moved", async () => {
    expect(await checkForOlder(io().base)).toBe("over");
  });
});
