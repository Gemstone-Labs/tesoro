import { describe, expect, it } from "vitest";
import vectors from "../../../../programs/block_puzzle/tests/vectors.json";
import { pieceAt, replay, type Move } from "./engine";

const hex = (v: bigint) => v.toString(16).padStart(16, "0");
const toMoves = (m: number[][]): Move[] => m.map(([piece, x, y]) => ({ piece, x, y }));

describe("Rust parity vectors", () => {
  it("has vectors", () => {
    expect(vectors.pieces.length).toBeGreaterThan(0);
    expect(vectors.games.length).toBeGreaterThan(30);
    expect(vectors.rejects.length).toBeGreaterThan(10);
  });

  it.each(vectors.pieces.map((v) => [v.seed, v] as const))("pieces for seed %s", (_s, v) => {
    const got = v.pieces.map((_, i) => {
      const p = pieceAt(BigInt(v.seed), i);
      return [p.kind, p.gem ?? -1];
    });
    expect(got).toEqual(v.pieces);
  });

  it.each(vectors.games.map((v, i) => [i, v.seed, v] as const))("game %i (seed %s)", (_i, _s, v) => {
    const r = replay(BigInt(v.seed), toMoves(v.moves));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.score).toBe(v.score);
    expect(r.state.moves).toBe(v.count);
    expect(r.state.over).toBe(v.over);
    expect(hex(r.state.occ)).toBe(v.occ);
    expect(hex(r.state.gems)).toBe(v.gems);
  });

  it.each(vectors.rejects.map((v, i) => [i, v.error, v] as const))("reject %i (%s)", (_i, _e, v) => {
    const r = replay(BigInt(v.seed), toMoves(v.moves));
    expect(r).toEqual({ ok: false, error: v.error, at: v.at });
  });
});
