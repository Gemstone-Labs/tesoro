import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

async function load(showRailcar: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", "");
  vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", showRailcar ? "1" : "");
  return import("@/server/history/reads");
}

// Staging and Production share one history: on 2026-11-25 Production's Live wins listed 7 Railcar rides in 12 rows, each opening "Match not found".
const rows = [
  { id: "car-16", game: "railcar" },
  { id: "bb-1", game: "block-puzzle" },
  { id: "car-15", game: "railcar" },
  { id: "hd-1", game: "holdem" },
  // A row whose program this build does not know keeps the program id as its game (ingest.ts: gameOf(...) ?? game).
  { id: "car-17", game: "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam" },
];
const rpc = (async () => rows) as never;

describe("history rows of a Game this environment does not show", () => {
  it("leaves Railcar rides and unknown programs out of recent wins where Railcar is not shown", async () => {
    const r = await load(false);
    expect((await r.visibleRecentWins(rpc, { limit: 12 })).map((w) => w.id)).toEqual(["bb-1", "hd-1"]);
  });

  it("keeps Railcar rides where Railcar is shown, never an unknown program", async () => {
    const r = await load(true);
    expect((await r.visibleRecentWins(rpc, { limit: 12 })).map((w) => w.id)).toEqual(["car-16", "bb-1", "car-15", "hd-1"]);
  });
});
