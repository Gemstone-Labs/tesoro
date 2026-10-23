import { describe, expect, it } from "vitest";
import { CATALOGUE, LOBBY_ORDER } from "@/lib/catalogue";

describe("Game order on Play", () => {
  it("is Vanguard, Hold'em, Trading Duel, Block Burst", () => {
    expect(LOBBY_ORDER).toEqual(["vanguard", "holdem", "trading-duel", "block-puzzle"]);
  });
  it("orders the Games grid's live Games, before the coming-soon ones", () => {
    const live = CATALOGUE.filter((c) => c.live);
    expect(live.map((c) => c.game)).toEqual(LOBBY_ORDER);
    expect(CATALOGUE.slice(0, live.length)).toEqual(live);
  });
});
