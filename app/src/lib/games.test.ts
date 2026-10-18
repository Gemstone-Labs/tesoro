import { describe, expect, it } from "vitest";
import { GAME_LIST, isGameId } from "./games";
import { GAME_NAMES } from "./mock/data";
import { GAME_IDS } from "./chain/match-flow";
import { gameFromParam } from "./game-params";
import { gameFilter } from "@/components/match/MatchHistory";

describe("the Game list", () => {
  it("names every Game once", () => {
    expect([...GAME_LIST].sort()).toEqual(["block-puzzle", "holdem", "trading-duel", "vanguard"]);
  });
  it("accepts only Game ids", () => {
    expect(isGameId("vanguard")).toBe(true);
    expect(isGameId("toString")).toBe(false);
    expect(isGameId(null)).toBe(false);
  });
  it.each(GAME_LIST)("%s has a name, a program, a param and a history filter", (g) => {
    expect(GAME_NAMES[g]).toBeTruthy();
    expect(GAME_IDS[g]).toBeDefined();
    expect(gameFromParam(g)).toBe(g);
    expect(gameFilter(g)).toBe(g);
  });
});
