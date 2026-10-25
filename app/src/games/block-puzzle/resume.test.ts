import { describe, expect, it } from "vitest";
import * as engine from "./engine";
import { fixtureBoard } from "./live-fixtures";
import { packMove } from "./live-chain";
import { resumeState } from "./resume";

/** A run played with the engine: the first `n` legal moves, found by scanning the board. */
function play(seed: bigint, n: number) {
  let st = engine.newState(seed);
  const log: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = engine.handBase(st);
    let moved = false;
    for (let p = base; p < base + engine.HAND && !moved; p++) {
      if ((st.used >> (p - base)) & 1) continue;
      for (let y = 0; y < engine.SIZE && !moved; y++) {
        for (let x = 0; x < engine.SIZE && !moved; x++) {
          try {
            st = engine.apply(st, { piece: p, x, y }).state;
            log.push(packMove(base, { piece: p, x, y }));
            moved = true;
          } catch {
            // not legal here
          }
        }
      }
    }
    if (!moved) break;
  }
  return { st, log };
}

describe("resumeState (the reconnect)", () => {
  const seed = 0x5eed1234abcdn;
  it("a Board with moves resumes exactly where the chain holds it", () => {
    const { st, log } = play(seed, 14);
    expect(st.moves).toBeGreaterThan(5);
    const board = fixtureBoard({ began: true, seed, moves: st.moves, score: st.score, log: Uint8Array.from(log) });
    const resumed = resumeState(board);
    expect(resumed.moves).toBe(st.moves);
    expect(resumed.score).toBe(st.score);
    expect(resumed.occ).toBe(st.occ);
  });
  it("a Board that has not moved resumes from its stored state", () => {
    const fresh = engine.newState(seed);
    const board = fixtureBoard({ began: true, seed, occ: fresh.occ, gems: fresh.gems });
    expect(resumeState(board).seed).toBe(seed);
  });
  it("refuses a log that does not replay to the Board", () => {
    const { st, log } = play(seed, 10);
    const board = fixtureBoard({ began: true, seed, moves: st.moves, score: st.score + 1, log: Uint8Array.from(log) });
    expect(() => resumeState(board)).toThrow(/does not replay/);
  });
});
