import { describe, expect, it } from "vitest";
import { MAX_MOVES } from "@/games/block-puzzle/live-chain";
import type { EndState } from "@/server/history/end-state";
import { runsFromEndState } from "./runs";

function end(moves: [number, number], slots: [number[], number[]]): EndState {
  const offsets = Buffer.alloc(4 * MAX_MOVES);
  slots.forEach((list, seat) => list.forEach((s, i) => offsets.writeUInt16LE(s, seat * MAX_MOVES * 2 + 2 * i)));
  return { game: "block-puzzle", scores: [10, 5], moves, reason: 1, log: { seed: "7", seedHash: "00", startSlot: 100, moves: "", offsets: offsets.toString("hex") } };
}

describe("runs from a Block Burst end state", () => {
  it("turns each side's logged slot offsets into batches, moves in one transaction sharing an offset", () => {
    const runs = runsFromEndState("m-1", ["A", "B"], end([4, 2], [[10, 10, 25, 25], [7, 30]]));
    expect(runs).toEqual([
      { matchId: "m-1", account: "A", batches: [{ slots: 10, moves: 2 }, { slots: 25, moves: 2 }] },
      { matchId: "m-1", account: "B", batches: [{ slots: 7, moves: 1 }, { slots: 30, moves: 1 }] },
    ]);
  });
  it("skips a side that never moved, a Match without a kept log and other Games", () => {
    expect(runsFromEndState("m", ["A", "B"], end([0, 1], [[], [3]])).map((r) => r.account)).toEqual(["B"]);
    expect(runsFromEndState("m", ["A", "B"], { ...end([1, 1], [[1], [1]]), log: null } as EndState)).toEqual([]);
    expect(runsFromEndState("m", ["A", "B"], { game: "holdem" } as EndState)).toEqual([]);
  });
});
