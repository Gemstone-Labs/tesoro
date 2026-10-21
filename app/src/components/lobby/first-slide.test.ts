import { describe, expect, it } from "vitest";
import { firstSlideGame } from "./first-slide";

const seat = (player: string) => ({ player, funder: player, entry: 1000, asset: 0 });
const GAMES = ["block-puzzle", "holdem", "trading-duel"] as const;

describe("firstSlideGame", () => {
  it("keeps the default while the Queue is loading", () => {
    expect(firstSlideGame(null, GAMES)).toBeNull();
  });
  it("leads with the first Game that has someone waiting", () => {
    expect(firstSlideGame({ "block-puzzle": [], holdem: [], "trading-duel": [seat("a")] }, GAMES)).toBe("trading-duel");
    expect(firstSlideGame({ "block-puzzle": [seat("a")], holdem: [seat("b")], "trading-duel": [] }, GAMES)).toBe("block-puzzle");
  });
  it("falls back to Block Puzzle when no Queue has anyone", () => {
    expect(firstSlideGame({ "block-puzzle": [], holdem: [], "trading-duel": [] }, GAMES)).toBe("block-puzzle");
  });
  it("falls back to the first slide, whichever Game leads", () => {
    expect(firstSlideGame({ "block-puzzle": [], holdem: [], "trading-duel": [] }, ["holdem", "trading-duel", "block-puzzle"])).toBe("holdem");
  });
  it("ignores your own seat", () => {
    const q = { "block-puzzle": [seat("me")], holdem: [seat("me"), seat("b")], "trading-duel": [] };
    expect(firstSlideGame(q, GAMES, "me")).toBe("holdem");
  });
});
