import { describe, expect, it } from "vitest";
import { ROSTER, TRUCK_FUEL, isWadi, type Army, type Game, type Rank } from "../rules";
import { DEFAULT_PACE, aggregate, renderReport, runBatch, runMatch } from "./simulate";

const counts = (g: Game, army: Army) => {
  const out = new Map<Rank, number>();
  for (const p of g.pieces) if (p.army === army) out.set(p.rank, (out.get(p.rank) ?? 0) + 1);
  return out;
};

describe("Vanguard bot simulation", () => {
  it("ends every Match and keeps the board lawful after every action", () => {
    for (let seed = 1; seed <= 16; seed++) {
      let prev: Game | null = null;
      const m = runMatch(seed, {
        first: seed % 2 ? "us" : "it",
        onStep: (g) => {
          const squares = new Set(g.pieces.map((p) => `${p.r},${p.c}`));
          expect(squares.size).toBe(g.pieces.length);
          expect(g.pieces.some((p) => isWadi(p.r, p.c))).toBe(false);
          expect(g.pieces.every((p) => p.fuel <= TRUCK_FUEL)).toBe(true);
          if (prev) {
            for (const army of ["us", "it"] as const) {
              const before = counts(prev, army);
              const after = counts(g, army);
              for (const [rank, n] of after) expect(n).toBeLessThanOrEqual(before.get(rank) ?? 0);
            }
          }
          prev = g;
        },
      });
      expect(m.winner).not.toBeNull();
      expect(m.reason).not.toBeNull();
    }
    expect(ROSTER.length).toBeGreaterThan(0);
  }, 30_000); // every action runs the board invariants: ~4 s per 16 Matches on an idle machine, several times that under load

  it("gives the same report for the same seed and count", () => {
    const a = renderReport(aggregate(runBatch({ seed: 7, count: 30 }), DEFAULT_PACE), { seed: 7, count: 30 });
    const b = renderReport(aggregate(runBatch({ seed: 7, count: 30 }), DEFAULT_PACE), { seed: 7, count: 30 });
    const c = renderReport(aggregate(runBatch({ seed: 8, count: 30 }), DEFAULT_PACE), { seed: 8, count: 30 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("counts the safety cap when a Match is cut short by a tiny move cap", () => {
    const rows = runBatch({ seed: 3, count: 20, capMoves: 12 });
    expect(rows.every((r) => r.reason === "cap" || r.moves <= 12)).toBe(true);
    expect(aggregate(rows, DEFAULT_PACE).reasons.cap).toBeGreaterThan(0);
  });

  it("ends on the time cap when thinking is slow", () => {
    const rows = runBatch({ seed: 3, count: 10, capMs: 20_000 });
    expect(rows.some((r) => r.cappedBy === "time")).toBe(true);
  });
});
