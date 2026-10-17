import { describe, expect, it } from "vitest";
import { PRIZE_BPS, SEASON_EPOCH, SEASON_SECS, pointsForWin, prizeAmounts, seasonAt, seasonEnd, seasonStart, standings } from "./season";

describe("season clock", () => {
  it("starts on a Monday 00:00 UTC and runs a week", () => {
    const d = new Date(SEASON_EPOCH * 1000);
    expect([d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([1, 0, 0]);
    expect(seasonAt(SEASON_EPOCH - 1)).toBe(0);
    expect(seasonAt(SEASON_EPOCH)).toBe(1);
    expect(seasonAt(SEASON_EPOCH + SEASON_SECS - 1)).toBe(1);
    expect(seasonAt(SEASON_EPOCH + SEASON_SECS)).toBe(2);
    expect(seasonStart(2)).toBe(seasonEnd(1));
  });
});

describe("points and prizes", () => {
  it("scales points with the entry", () => {
    expect([500, 1000, 2500].map(pointsForWin)).toEqual([5, 10, 25]);
  });
  it("pays the sliding scale, floored, and only to ranked places", () => {
    expect(PRIZE_BPS.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(prizeAmounts(30n, 2).slice(0, 3)).toEqual([7n, 5n, 0n]);
    expect(prizeAmounts(12_345n, 10)[0]).toBe(3_086n);
    expect(prizeAmounts(1_000n, 0).every((a) => a === 0n)).toBe(true);
  });
});

describe("standings", () => {
  const w = (player: string, points: number, ts: number) => ({ player, points, ts, matchId: `${player}${ts}` });
  it("sums points and wins per Player", () => {
    const rows = standings([w("a", 10, 5), w("b", 25, 6), w("a", 5, 7)]);
    expect(rows.map((r) => [r.account, r.points, r.wins, r.rank])).toEqual([["b", 25, 1, 1], ["a", 15, 2, 2]]);
  });
  it("breaks ties by the earlier first win, then by key", () => {
    const rows = standings([w("c", 10, 9), w("b", 10, 3), w("a", 10, 9)]);
    expect(rows.map((r) => r.account)).toEqual(["b", "a", "c"]);
  });
  it("is empty without wins", () => {
    expect(standings([])).toEqual([]);
  });
});

describe("points cap per opponent", () => {
  const w = (player: string, loser: string | undefined, n: number) => ({ player, loser, points: 10, ts: 100 + n, matchId: String(n) });
  it("only the first 3 wins against one opponent earn Points; wins still count", () => {
    const rows = standings([4, 2, 1, 3, 5].map((n) => w("a", "b", n)));
    expect(rows).toHaveLength(1);
    expect([rows[0].points, rows[0].wins]).toEqual([30, 5]);
  });
  it("counts opponents separately and leaves wins without a loser uncapped", () => {
    const rows = standings([...[1, 2, 3, 4].map((n) => w("a", "b", n)), ...[5, 6, 7, 8].map((n) => w("a", "c", n)), ...[9, 10, 11, 12].map((n) => w("a", undefined, n))]);
    expect(rows[0].points).toBe(30 + 30 + 40);
  });
  it("a player with only capped wins is not ranked, ties still go to the first win", () => {
    const rows = standings([...[1, 2, 3, 4].map((n) => w("a", "b", n)), ...[50, 51, 52].map((n) => w("c", "d", n))]);
    expect(rows.map((r) => [r.account, r.points])).toEqual([["a", 30], ["c", 30]]);
  });
});
