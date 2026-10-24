import { describe, expect, it } from "vitest";
import { apply, pieceAt } from "../engine";
import { attemptPlacement, EMPTY_COLOR, FIXTURES, FIXTURE_SEED, hand, initialFixture } from "./model";

describe("isolated interaction fixtures", () => {
  it("always starts with the documented two four-bars and one two-bar", () => {
    expect(hand(initialFixture("placement")).map(({ piece }) => piece)).toEqual([
      { kind: 5, gem: null }, { kind: 5, gem: null }, { kind: 1, gem: null },
    ]);
    expect(initialFixture("consecutive")).toEqual(initialFixture("consecutive"));
  });

  it.each(FIXTURES)("$id walkthrough has fixed points and clear sequence", (fixture) => {
    const start = initialFixture(fixture.id);
    let state = start;
    const clears: number[] = [];
    const points: number[] = [];
    for (const move of fixture.sequence) {
      const before = state;
      const outcome = attemptPlacement(state, move.slot, move.x, move.y);
      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) throw new Error(outcome.error);
      const engine = apply(before.st, { piece: Math.floor(before.st.moves / 3) * 3 + move.slot, x: move.x, y: move.y });
      expect(outcome.state.st).toEqual(engine.state);
      expect(outcome.result).toEqual(engine.result);
      expect(outcome.cleared).toHaveLength(outcome.result.lines * 8);
      for (let i = 0; i < 64; i++) {
        expect(outcome.state.colors[i] === EMPTY_COLOR).toBe((outcome.state.st.occ & (1n << BigInt(i))) === 0n);
      }
      clears.push(outcome.result.lines);
      points.push(outcome.result.gained);
      state = outcome.state;
    }
    const expected = {
      placement: { clears: [0, 0, 0], points: [4, 4, 2], score: 10 },
      single: { clears: [1, 0, 0], points: [14, 4, 2], score: 20 },
      consecutive: { clears: [1, 1, 0], points: [14, 14, 2], score: 30 },
      bridge: { clears: [1, 0, 1], points: [14, 4, 12], score: 30 },
    }[fixture.id];
    expect(clears).toEqual(expected.clears);
    expect(points).toEqual(expected.points);
    expect(state.st.score).toBe(expected.score);
    expect(state.st.moves).toBe(3);
    expect(state.st.used).toBe(0);
    expect(hand(state).map(({ piece }) => piece)).toEqual([3, 4, 5].map((i) => pieceAt(FIXTURE_SEED, i)));
    expect(initialFixture(fixture.id)).toEqual(start);
  });

  it.each([
    [0, 0, 0, "Occupied"],
    [0, -1, 3, "OutOfBounds"],
    [0, 5, 3, "OutOfBounds"],
    [0, 0, 8, "OutOfBounds"],
    [0, 1.5, 3, "OutOfBounds"],
    [0, Number.NaN, 3, "OutOfBounds"],
    [3, 0, 3, "BadPiece"],
    [-1, 0, 3, "BadPiece"],
  ] as const)("rejects slot %s at %s,%s with %s and preserves the original state", (slot, x, y, error) => {
    const state = initialFixture("placement");
    const snapshot = structuredClone(state);
    const outcome = attemptPlacement(state, slot, x, y);
    expect(outcome).toEqual({ accepted: false, state, error });
    expect(outcome.state).toBe(state);
    expect(state).toEqual(snapshot);
  });

  it("cannot spend the same tray piece twice", () => {
    const first = attemptPlacement(initialFixture("placement"), 0, 2, 3);
    if (!first.accepted) throw new Error(first.error);
    const second = attemptPlacement(first.state, 0, 2, 5);
    expect(second).toEqual({ accepted: false, state: first.state, error: "PieceUsed" });
    expect(second.state.st.score).toBe(4);
    expect(second.state.st.moves).toBe(1);
  });
});
