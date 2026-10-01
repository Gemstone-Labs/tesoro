import { describe, expect, it } from "vitest";
import { pickSettled, topScores, type SettledCandidate, type SettledMatch } from "./settled";

const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const row = (hoursAgo: number, game: SettledCandidate["game"], over: Partial<SettledCandidate> = {}): SettledCandidate => ({
  id: BigInt(NOW - hoursAgo * HOUR) << 1n,
  game,
  settled: true,
  joined: true,
  ...over,
});

describe("pickSettled", () => {
  it("filters by game and time before cutting to the limit", () => {
    // 60 Hold'em Matches settled in the last hour, then three Block Puzzle Matches earlier today.
    const holdem = Array.from({ length: 60 }, (_, i) => row(i / 60, "holdem"));
    const bp = [row(3, "block-puzzle"), row(10, "block-puzzle"), row(23, "block-puzzle")];
    const picked = pickSettled([...holdem, ...bp, row(25, "block-puzzle")], { game: "block-puzzle", since: NOW - 24 * HOUR, limit: 40 });
    expect(picked).toEqual(bp);
  });

  it("skips unsettled, unjoined and unknown-game Matches", () => {
    const rows = [row(1, "block-puzzle", { settled: false }), row(1, "block-puzzle", { joined: false }), row(1, null), row(2, "block-puzzle")];
    expect(pickSettled(rows, { limit: 10 })).toEqual([rows[3]]);
  });

  it("keeps the newest first", () => {
    const rows = [row(5, "holdem"), row(1, "block-puzzle"), row(3, "holdem")];
    expect(pickSettled(rows, { limit: 2 })).toEqual([rows[1], rows[2]]);
  });
});

describe("topScores", () => {
  const m = (winner: string, score: number): SettledMatch => ({ id: 0n, game: "block-puzzle", entry: 500, winner, payout: 950, scores: [score, 1], at: 0 });
  it("keeps each Player's best winning score, highest first, top 3", () => {
    expect(topScores([m("a", 90), m("b", 120), m("a", 150), m("c", 30), m("d", 60)])).toEqual([
      ["a", 150],
      ["b", 120],
      ["d", 60],
    ]);
  });
});
