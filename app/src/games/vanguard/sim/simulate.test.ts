import { describe, expect, it } from "vitest";
import { ROSTER, TRUCK_FUEL, isWadi, type Army, type Game, type Rank } from "../rules";
import { startGame } from "../rules";
import { POWERS, aggregate, renderReport, runBatch, runMatch, runStudy, sealedTrucks } from "./simulate";

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
          // only Majors (dug in) and the General of the Army (spy) ever change rank
          for (const id of Object.keys(g.changed)) {
            const piece = g.pieces.find((p) => p.id === Number(id)) ?? prev?.pieces.find((p) => p.id === Number(id));
            expect(piece && ["7", "10"].includes(piece.rank)).toBe(true);
            expect(g.changed[Number(id)]).toBe(piece?.rank === "7" ? "dug" : "spy");
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
    const report = (seed: number) => renderReport(runStudy({ seed, count: 12 }), { seed, count: 12 });
    expect(report(7)).toBe(report(7));
    expect(report(7)).not.toBe(report(8));
  }, 60_000);

  it("uses every power in a seeded run and counts them", () => {
    const rows = runBatch({ seed: 1, count: 120 });
    const s = aggregate(rows);
    for (const p of ["dig_in", "rescue", "blast", "sergeant_run", "captain_diagonal"] as const) expect(s.powerUse[p].share).toBeGreaterThan(0);
    expect(POWERS.every((p) => s.powerUse[p].perMatch >= 0)).toBe(true);
  }, 60_000);

  it("plays the version-5 plain bot with no power used", () => {
    const rows = runBatch({ seed: 1, count: 10, version: 5, policies: { us: "plain", it: "plain" } });
    for (const r of rows) for (const p of ["dig_in", "blast", "rescue", "switch", "sergeant_run", "captain_diagonal", "lieutenant_jump", "general_crossing"] as const) expect(r.powers[p]).toBe(0);
  }, 30_000);

  it("finds a sealed Truck by the spec definition", () => {
    const layout = [
      { army: "it" as const, rank: "F" as const, r: 0, c: 0 },
      { army: "it" as const, rank: "B" as const, r: 0, c: 1 },
      { army: "it" as const, rank: "B" as const, r: 1, c: 0 },
      { army: "it" as const, rank: "7" as const, r: 1, c: 1 },
      { army: "us" as const, rank: "F" as const, r: 9, c: 9 },
      { army: "us" as const, rank: "5" as const, r: 9, c: 8 },
    ];
    const g = startGame(layout, { startedAt: 0, stormAt: 99, stormSeed: 1, first: "us" });
    expect(sealedTrucks(g).it).toBe(false); // the Major has not dug in
    const dug = { ...g, changed: { [g.pieces.find((p) => p.r === 1 && p.c === 1)!.id]: "dug" as const } };
    expect(sealedTrucks(dug).it).toBe(false); // the US Lieutenant can still jump in
    expect(sealedTrucks({ ...dug, pieces: dug.pieces.filter((p) => p.rank !== "5") }).it).toBe(true);
    expect(sealedTrucks(dug).us).toBe(false); // the US Truck has open neighbours
  });

  it("counts the safety cap when a Match is cut short by a tiny move cap", () => {
    const rows = runBatch({ seed: 3, count: 20, capMoves: 12 });
    expect(rows.every((r) => r.reason === "cap" || r.moves <= 12)).toBe(true);
    expect(aggregate(rows).reasons.cap).toBeGreaterThan(0);
  });

  it("ends on the time cap when thinking is slow", () => {
    const rows = runBatch({ seed: 3, count: 10, capMs: 20_000 });
    expect(rows.some((r) => r.cappedBy === "time")).toBe(true);
  });
});
