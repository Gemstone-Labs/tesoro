import { describe, expect, it } from "vitest";
import { batchOffsets, boardTiming } from "./move-timing";

const moveSlots = [...Array(120).fill(0)];
moveSlots.fill(7, 0, 20);
moveSlots.fill(50, 20, 30);

describe("boardTiming", () => {
  const t = boardTiming({ startSlot: { toString: () => "1000" }, moves: 30, moveSlots });
  it("surfaces one offset per played move", () => {
    expect(t.startSlot).toBe(1000n);
    expect(t.moves).toHaveLength(30);
    expect(t.moves[0]).toEqual({ index: 0, slots: 7 });
    expect(t.moves[29]).toEqual({ index: 29, slots: 50 });
  });
  it("groups moves by transaction", () => {
    expect(batchOffsets(t)).toEqual([
      { slots: 7, moves: 20 },
      { slots: 50, moves: 10 },
    ]);
  });
  it("is empty before any move", () => {
    expect(boardTiming({ startSlot: 0, moves: 0, moveSlots }).moves).toEqual([]);
  });
});
