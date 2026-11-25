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
];
const rpc = (async (fn: string) => (fn === "recent_wins" ? rows : { rows, page: 1, pages: 1, total: rows.length })) as never;

describe("history rows of a Game this environment does not show", () => {
  it("leaves Railcar rides out of recent wins and account history where Railcar is not shown", async () => {
    const r = await load(false);
    expect((await r.visibleRecentWins(rpc, { limit: 12 })).map((w) => w.id)).toEqual(["bb-1", "hd-1"]);
    expect((await r.visibleAccountHistory(rpc, "acct", 1, 10, null)).rows.map((w) => w.id)).toEqual(["bb-1", "hd-1"]);
  });

  it("keeps them where Railcar is shown", async () => {
    const r = await load(true);
    expect((await r.visibleRecentWins(rpc, { limit: 12 })).map((w) => w.id)).toEqual(["car-16", "bb-1", "car-15", "hd-1"]);
  });
});
