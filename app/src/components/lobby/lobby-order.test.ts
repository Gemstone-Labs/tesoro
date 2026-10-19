import { describe, expect, it } from "vitest";
import { CATALOGUE, LOBBY_ORDER } from "@/lib/catalogue";
import { SLIDES } from "./HeroCarousel";

describe("Lobby game order", () => {
  it("is Hold'em, Trading Duel, Block Puzzle", () => {
    expect(LOBBY_ORDER).toEqual(["holdem", "trading-duel", "block-puzzle"]);
  });
  it("orders the hero carousel", () => {
    expect(SLIDES.map((s) => s.game)).toEqual(LOBBY_ORDER);
  });
  it("orders the Play Now grid's live Games, before the coming-soon ones", () => {
    const live = CATALOGUE.filter((c) => c.live);
    expect(live.map((c) => c.game)).toEqual(LOBBY_ORDER);
    expect(CATALOGUE.slice(0, live.length)).toEqual(live);
  });
});
