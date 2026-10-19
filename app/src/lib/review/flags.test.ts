import { describe, expect, it } from "vitest";
import type { Win } from "../chain/season";
import { MIN_BATCHES, pairFlags, reviewFlags, runPace, timingFlags, winRateFlags, type RunBatches } from "./flags";

const cadence = (n: number, gapOf: (i: number) => number, moves = 1) => {
  let t = 5;
  return Array.from({ length: n }, (_, i) => ({ slots: (t += gapOf(i)), moves }));
};
const human = (i: number) => [30, 80, 45, 120, 60, 200, 38, 95, 150, 52][i % 10];
const run = (matchId: string, account: string, batches: RunBatches["batches"]): RunBatches => ({ matchId, account, batches });

describe("runPace", () => {
  it("ignores runs with too few batches", () => {
    expect(runPace(cadence(MIN_BATCHES - 1, () => 1))).toBeNull();
  });
  it("passes a human cadence", () => {
    const p = runPace(cadence(12, human))!;
    expect(p.tooFast).toBe(false);
    expect(p.tooUniform).toBe(false);
  });
  it("flags a fast cadence", () => {
    expect(runPace(cadence(12, (i) => 2 + (i % 3)))!.tooFast).toBe(true);
  });
  it("divides a gap by the moves in the batch", () => {
    expect(runPace(cadence(12, (i) => 40 + (i % 5) * 10, 20))!.tooFast).toBe(true);
  });
  it("flags a metronome even when slow", () => {
    const p = runPace(cadence(12, () => 60))!;
    expect(p.tooUniform).toBe(true);
    expect(p.tooFast).toBe(false);
  });
});

describe("timingFlags", () => {
  const bot = (id: string, acc: string) => run(id, acc, cadence(12, () => 3));
  it("needs two scripted runs", () => {
    expect(timingFlags(1, [bot("1", "A"), run("2", "A", cadence(12, human))])).toEqual([]);
    const f = timingFlags(1, [bot("1", "A"), bot("2", "A"), run("3", "B", cadence(12, human))]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "timing", account: "A", matchIds: ["1", "2"] });
  });
});

const win = (matchId: string, player: string, loser: string, ts = 1): Win => ({ player, loser, matchId, points: 10, ts });

describe("pairFlags", () => {
  it("flags a pair that keeps meeting, once, on the side that won more", () => {
    const wins = [...Array.from({ length: 7 }, (_, i) => win(`a${i}`, "B", "A")), win("x", "A", "B")];
    const f = pairFlags(2, wins);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ account: "B", other: "A", season: 2 });
    expect(f[0].summary).toContain("Lopsided");
    expect(f[0].matchIds).toHaveLength(8);
  });
  it("is not lopsided when results are even, and ignores few meetings", () => {
    const even = Array.from({ length: 8 }, (_, i) => (i % 2 ? win(`a${i}`, "A", "B") : win(`a${i}`, "B", "A")));
    expect(pairFlags(1, even)[0].summary).not.toContain("Lopsided");
    expect(pairFlags(1, even.slice(0, 7))).toEqual([]);
  });
  it("skips wins without a known loser", () => {
    expect(pairFlags(1, Array.from({ length: 10 }, (_, i) => ({ player: "A", matchId: `${i}`, points: 1, ts: 1 })))).toEqual([]);
  });
});

describe("winRateFlags", () => {
  it("flags a high win rate over enough Matches", () => {
    const wins = [...Array.from({ length: 16 }, (_, i) => win(`w${i}`, "A", `L${i}`)), ...Array.from({ length: 4 }, (_, i) => win(`l${i}`, `O${i}`, "A"))];
    const f = winRateFlags(1, wins);
    expect(f.map((x) => x.account)).toEqual(["A"]);
    expect(f[0].summary).toContain("16 of 20");
  });
  it("needs 20 decided Matches and 75%", () => {
    expect(winRateFlags(1, Array.from({ length: 19 }, (_, i) => win(`w${i}`, "A", `L${i}`)))).toEqual([]);
    const half = [...Array.from({ length: 10 }, (_, i) => win(`w${i}`, "A", `L${i}`)), ...Array.from({ length: 10 }, (_, i) => win(`l${i}`, `O${i}`, "A"))];
    expect(winRateFlags(1, half).filter((f) => f.account === "A")).toEqual([]);
  });
});

describe("reviewFlags", () => {
  it("lists the newest Season first", () => {
    const wins = Array.from({ length: 8 }, (_, i) => win(`m${i}`, "B", "A"));
    const out = reviewFlags([
      { season: 1, wins, runs: [] },
      { season: 2, wins, runs: [] },
    ]);
    expect(out.map((f) => f.season)).toEqual([2, 1]);
  });
});
