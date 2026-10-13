import { describe, expect, it } from "vitest";
import type { ChainRequest } from "./backing";
import { liveRequestFor, onePerPlayer } from "./requests";

const req = (id: string, player: string, over: Partial<ChainRequest> = {}) =>
  ({ address: { toBase58: () => id }, player, game: "block-puzzle", entry: 100, expiresAt: 1000, live: true, ...over }) as unknown as ChainRequest;

describe("onePerPlayer", () => {
  it("keeps each Player's soonest-expiring live Request", () => {
    const out = onePerPlayer([req("a", "p1", { expiresAt: 900 }), req("b", "p1", { expiresAt: 500 }), req("c", "p2")]);
    expect(out.map((r) => r.address.toBase58())).toEqual(["b", "c"]);
  });
  it("ignores expired Requests, so a Player with only those is absent", () => {
    const out = onePerPlayer([req("a", "p1", { live: false, expiresAt: 1 }), req("b", "p1", { expiresAt: 800 }), req("c", "p2", { live: false })]);
    expect(out.map((r) => r.address.toBase58())).toEqual(["b"]);
  });
  it("breaks ties by first seen", () => {
    expect(onePerPlayer([req("a", "p1"), req("b", "p1")]).map((r) => r.address.toBase58())).toEqual(["a"]);
  });
});

describe("liveRequestFor", () => {
  it("finds the Player's live Request for the same Game and entry", () => {
    const rs = [req("a", "p1", { entry: 50 }), req("b", "p1"), req("c", "p2"), req("d", "p1", { live: false })];
    expect(liveRequestFor(rs, "p1", "block-puzzle", 100)?.address.toBase58()).toBe("b");
    expect(liveRequestFor(rs, "p1", "holdem", 100)).toBeUndefined();
  });
});
