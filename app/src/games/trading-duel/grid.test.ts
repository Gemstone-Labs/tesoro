import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as G from "./grid";

interface Vector {
  name: string;
  asset: G.GridAsset;
  stepPpm: number;
  anchor: string;
  step: string;
  samples: [number, string][];
  picks: [number[], number[]];
  expected: { lo: (string | null)[]; hi: (string | null)[]; hits: [boolean[], boolean[]]; scores: [number, number]; winner: G.Winner };
}
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../programs/trading_duel/tests/fixtures/grid-vectors.json"), "utf8"));

describe("fixture constants", () => {
  it("match grid.ts", () => {
    const c = fixture.constants;
    expect([G.MAX_BAND, G.COLUMNS, G.COLUMN_SECS, G.HEAD_START_SECS, G.LOCK_AHEAD_SECS, G.HIT_POINTS, G.NO_PICK, G.MATCH_SECS]).toEqual([c.MAX_BAND, c.COLUMNS, c.COLUMN_SECS, c.HEAD_START_SECS, c.LOCK_AHEAD_SECS, c.HIT_POINTS, c.NO_PICK, c.MATCH_SECS]);
    for (const k of ["SOL", "ETH", "HYPE"] as const) expect(G.STEP_PPM[k]).toBe(BigInt(c.STEP_PPM[k]));
  });
});

describe("bands", () => {
  it.each(fixture.bands as { anchor: string; step: string; price: string; band: number }[])("price $price (anchor $anchor, step $step) is band $band", (r) => {
    expect(G.bandOf(BigInt(r.price), BigInt(r.anchor), BigInt(r.step))).toBe(r.band);
  });

  it("floors negative quotients", () => {
    expect(G.floorDiv(-1n, 5n)).toBe(-1n);
    expect(G.floorDiv(-5n, 5n)).toBe(-1n);
    expect(G.floorDiv(-6n, 5n)).toBe(-2n);
    expect(G.floorDiv(6n, 5n)).toBe(1n);
  });

  it("derives the step from the anchor and never below 1", () => {
    for (const v of fixture.vectors as Vector[]) expect(G.stepFor(BigInt(v.anchor), BigInt(v.stepPpm))).toBe(BigInt(v.step));
  });

  it("bands tile the price line, below and above the anchor", () => {
    const a = 100_00000000n;
    const s = 2_500_000n;
    expect(G.bandEdges(0, a, s)).toEqual({ from: a, to: a + s });
    expect(G.bandEdges(-3, a, s)).toEqual({ from: a - 3n * s, to: a - 2n * s });
    for (let k = -40; k < 40; k++) {
      expect(G.bandEdges(k, a, s).to).toBe(G.bandEdges(k + 1, a, s).from);
      const { from, to } = G.bandEdges(k, a, s);
      expect([G.bandOf(from, a, s), G.bandOf(to - 1n, a, s), G.bandOf(to, a, s)]).toEqual([k, k, k + 1]);
    }
  });

  it("never returns NO_PICK: far prices clamp", () => {
    expect(G.bandOf(10n ** 15n, 1n, 1n)).toBe(G.MAX_BAND);
    expect(G.bandOf(0n, 10n ** 15n, 1n)).toBe(-G.MAX_BAND);
    expect(G.NO_PICK).toBeLessThan(-G.MAX_BAND);
  });
});

describe("timing", () => {
  it.each(fixture.locks as { column: number; columnStart: number; columnEnd: number; lockAt: number }[])("column $column", (l) => {
    expect([G.columnStart(l.column), G.columnEnd(l.column), G.lockAt(l.column)]).toEqual([l.columnStart, l.columnEnd, l.lockAt]);
  });

  it("accepts picks strictly before the lock", () => {
    expect(G.canPick(0, 19.99)).toBe(true);
    expect(G.canPick(0, 20)).toBe(false);
    expect(G.canPick(11, 129.9)).toBe(true);
    expect(G.canPick(11, 130)).toBe(false);
    expect(G.canPick(12, 0)).toBe(false);
  });

  it("finds the column of a time", () => {
    expect([G.columnAt(0), G.columnAt(29), G.columnAt(30), G.columnAt(39), G.columnAt(40), G.columnAt(149), G.columnAt(150)]).toEqual([-1, -1, 0, 0, 1, 11, -1]);
  });

  it("names column states and the next lock", () => {
    expect([0, 19, 20, 29, 30, 39, 40].map((t) => G.columnState(0, t))).toEqual(["open", "open", "locked", "locked", "live", "live", "done"]);
    expect(G.nextLock(0)).toEqual({ column: 0, inSecs: 20 });
    expect(G.nextLock(20)).toEqual({ column: 1, inSecs: 10 });
    expect(G.nextLock(129.5)).toEqual({ column: 11, inSecs: 0.5 });
    expect(G.nextLock(130)).toBeNull();
    expect(G.headStartLeft(12)).toBe(18);
    expect(G.headStartLeft(40)).toBe(0);
  });
});

describe("shared vectors", () => {
  it.each(fixture.vectors as Vector[])("$name", (v) => {
    const anchor = BigInt(v.anchor);
    const step = BigInt(v.step);
    let tr = G.newTrack();
    for (const [t, p] of v.samples) tr = G.record(tr, t, BigInt(p));
    tr = G.finish(tr);
    expect(tr.lo.map((x, c) => (tr.seen[c] ? String(x) : null))).toEqual(v.expected.lo);
    expect(tr.hi.map((x, c) => (tr.seen[c] ? String(x) : null))).toEqual(v.expected.hi);
    const r = G.settle(tr, v.picks, anchor, step);
    expect(r.hits).toEqual(v.expected.hits);
    expect(r.scores).toEqual(v.expected.scores);
    expect(r.winner).toBe(v.expected.winner);
  });
});

describe("rules in isolation", () => {
  const A = 100_00000000n;
  const S = 2_500_000n;
  it("ignores samples at or after the end", () => {
    let tr = G.record(G.newTrack(), 30, A);
    tr = G.record(tr, 150, A + 50n * S);
    expect(tr.hi[11]).toBe(0n);
    expect(tr.last).toBe(A);
  });

  it("finishing adds no end price: later columns carry the last recorded price", () => {
    let tr = G.record(G.newTrack(), 0, A);
    tr = G.record(tr, 125, A + 3n * S);
    const done = G.finish(tr);
    expect(done.lo[11]).toBe(A + 3n * S);
    expect(done.hi[11]).toBe(A + 3n * S);
    expect(done.lo[9]).toBe(A);
    expect(done.hi[9]).toBe(A + 3n * S);
    expect(G.finish(G.newTrack()).seen.some(Boolean)).toBe(false);
  });

  it("does not mutate the track it was given", () => {
    const tr = G.newTrack();
    G.record(tr, 35, A);
    expect(tr.seen.some(Boolean)).toBe(false);
  });

  it("an unpicked column never scores; far bands hit only where the line went", () => {
    const tr = G.finish(G.record(G.newTrack(), 0, A));
    expect(G.hits(tr, 0, 8, A, S)).toBe(false);
    expect(G.hits(tr, 0, -1, A, S)).toBe(false);
    expect(G.settle(tr, [Array(12).fill(G.NO_PICK), Array(12).fill(0)], A, S).winner).toBe(1);
  });

  it("a climb through many bands hits each of them", () => {
    let tr = G.newTrack();
    for (let t = 0; t < 150; t++) tr = G.record(tr, t, A + BigInt(t) * S);
    tr = G.finish(tr);
    expect([28, 29, 34, 39, 40].map((k) => G.hits(tr, 0, k, A, S))).toEqual([false, true, true, true, false]);
  });
});

describe("view helpers", () => {
  const A = 100_00000000n;
  const S = 2_500_000n;
  it("reports results only for finished, picked columns, and streaks", () => {
    let tr = G.newTrack();
    for (let t = 0; t < 70; t++) tr = G.record(tr, t, A);
    const picks = [0, -1, 0, G.NO_PICK, ...Array(8).fill(0)];
    const res = G.columnResults(tr, picks, 70, A, S);
    expect(res.slice(0, 4)).toEqual([true, false, true, null]);
    expect(G.totalScore(res)).toBe(200);
    expect(G.streaks([true, true, false, true, null, true])).toEqual([1, 2, 0, 1, 0, 1]);
  });

  it("hides unlocked picks from the other side", () => {
    const picks = Array.from({ length: 12 }, (_, c) => c % 8);
    const seen = G.revealed(picks, 35);
    expect(seen.slice(0, 3)).toEqual([0, 1, G.NO_PICK]);
    expect(seen.filter((p) => p !== G.NO_PICK)).toHaveLength(2);
  });
});
