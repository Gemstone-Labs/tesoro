import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("Railcar visibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the Railcar rulebook out of the Docs unless NEXT_PUBLIC_SHOW_RAILCAR=1", async () => {
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "");
    vi.resetModules();
    const hidden = await import("@/components/docs/nav");
    expect(hidden.ALL_PAGES.map((p) => p.href)).not.toContain("/docs/railcar");

    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "1");
    vi.resetModules();
    const shown = await import("@/components/docs/nav");
    expect(shown.ALL_PAGES.map((p) => p.href)).toContain("/docs/railcar");
  });
});
