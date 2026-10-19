import { describe, expect, it } from "vitest";
import { PAYOUT_WINDOW_SECS, payoutOpensAt, rankPayout } from "./season";
import { lastRankNote, nextStep, seasonStanding, standingSummary, type LeaderboardRow, type LeaderboardView } from "./leaderboard-view";

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

describe("payout window", () => {
  const opens = payoutOpensAt(1_000);
  const open = { paid: false, voided: false };
  it("opens 48 hours after the record", () => {
    expect(PAYOUT_WINDOW_SECS).toBe(172_800);
    expect(opens).toBe(1_000 + 172_800);
  });
  it("says Paying out <date> during the window, then plain paying", () => {
    expect(lastRankNote(open, opens, opens - 1)).toEqual({ kind: "paying", payoutAt: opens });
    expect(lastRankNote(open, opens, opens)).toEqual({ kind: "paying" });
    expect(rankPayout(open, opens, opens - 1)).toBe("waiting");
    expect(rankPayout(open, opens, opens)).toBe("due");
  });
  it("shows voided ranks as not paid and paid ranks as nothing", () => {
    expect(lastRankNote({ paid: false, voided: true }, opens, opens + 5)).toEqual({ kind: "voided" });
    expect(lastRankNote({ paid: true, voided: false }, opens, opens + 5)).toEqual({ kind: "none" });
  });
  it("a Season recorded before the window has no date", () => {
    expect(lastRankNote(open, null, 5)).toEqual({ kind: "paying" });
  });
});

describe("nextStep", () => {
  it("names the gap to the prizes, the rank above, or the top", () => {
    expect(nextStep(seasonStanding(view(), "p23"))).toBe("66 pts to the prizes");
    expect(nextStep(seasonStanding(view(), "p3"))).toBe("6 pts to 2nd");
    expect(nextStep(seasonStanding(view(), "p1"))).toBe("Top of the board");
    expect(nextStep(seasonStanding(view(), "nobody"))).toBeNull();
  });
  it("counts one point as pt", () => {
    expect(nextStep({ rank: 4, points: 9, toNext: 1, toPrizes: 0 })).toBe("1 pt to 3rd");
  });
});

describe("standingSummary", () => {
  it("joins points, rank and the next step", () => {
    expect(standingSummary(seasonStanding(view(), "p3"), 60, 5)).toBe("490 pts · 3rd · 6 pts to 2nd");
  });
  it("says what a win is worth without points", () => {
    expect(standingSummary(seasonStanding(view(), "nobody"), 60, 5)).toBe("No points yet · a win is +5");
  });
  it("says any win reaches the prizes on a thin board", () => {
    expect(standingSummary(seasonStanding(view(), "nobody"), 4, 5)).toBe("No points yet · any win puts you in the prizes");
  });
});
