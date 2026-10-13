import { describe, expect, it } from "vitest";
import { POOL_QUIET_BELOW, poolIsQuiet, seasonStanding, type LeaderboardRow, type LeaderboardView } from "./leaderboard-view";

const rows: LeaderboardRow[] = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, account: `p${i + 1}`, points: 500 - i * 5, wins: 1 }));
const view = (me?: LeaderboardRow | null): LeaderboardView => ({
  now: 0, season: { number: 1, start: 0, end: 1 }, poolGemas: 0, feeBps: 100, standings: rows, players: 60, last: null, settling: null, me,
});

describe("seasonStanding", () => {
  it("counts one point past the rank above", () => {
    expect(seasonStanding(view(), "p3")).toEqual({ rank: 3, points: 490, toNext: 6, toPrizes: 0 });
  });
  it("is top of the board at 1st", () => {
    expect(seasonStanding(view(), "p1").toNext).toBeNull();
  });
  it("counts to 10th outside the prizes", () => {
    expect(seasonStanding(view(), "p23")).toEqual({ rank: 23, points: 390, toNext: null, toPrizes: 66 });
  });
  it("reads the me row below the listed top", () => {
    expect(seasonStanding(view({ rank: 57, account: "x", points: 20, wins: 2 }), "x")).toEqual({ rank: 57, points: 20, toNext: null, toPrizes: 436 });
  });
  it("has no rank without points", () => {
    expect(seasonStanding(view(null), "nobody")).toEqual({ rank: null, points: 0, toNext: null, toPrizes: 0 });
  });
});

describe("poolIsQuiet", () => {
  it("keeps a small Pool out of sight below 1,000 Gemas", () => {
    expect(POOL_QUIET_BELOW).toBe(1000);
    expect(poolIsQuiet(0)).toBe(true);
    expect(poolIsQuiet(999)).toBe(true);
  });
  it("shows the Pool from 1,000 Gemas", () => {
    expect(poolIsQuiet(1000)).toBe(false);
    expect(poolIsQuiet(18_400)).toBe(false);
  });
});
