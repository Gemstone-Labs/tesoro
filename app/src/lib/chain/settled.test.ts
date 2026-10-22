import { describe, expect, it } from "vitest";
import { fetchSettled } from "./recent";
import { topScores, type SettledMatch } from "./settled";

const m = (winner: string, score: number): SettledMatch => ({ id: "opener-0", game: "block-puzzle", entry: 500, winner, payout: 950, scores: [score, 1], at: 0 });

describe("topScores", () => {
  it("keeps each Player's best winning score, highest first, top 3", () => {
    expect(topScores([m("a", 90), m("b", 120), m("a", 150), m("c", 30), m("d", 60)])).toEqual([
      ["a", 150],
      ["b", 120],
      ["d", 60],
    ]);
  });
});

describe("fetchSettled (recent wins from the Match history)", () => {
  const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("asks the route for one Game, since a time, with a limit", async () => {
    const urls: string[] = [];
    const rows = [m("a", 100)];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => rows };
    }) as unknown as typeof fetch;
    await expect(fetchSettled({ game: "block-puzzle", since: 1_790_000_000_000, limit: 40 }, fetcher)).resolves.toEqual(rows);
    expect(urls).toEqual(["/api/recent-wins?limit=40&game=block-puzzle&since=1790000000000"]);
  });

  it("is an empty ticker when the history is unavailable", async () => {
    await expect(fetchSettled({ limit: 8 }, answer({ error: "x" }, false))).resolves.toEqual([]);
    await expect(fetchSettled({ limit: 8 }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toEqual([]);
  });
});
