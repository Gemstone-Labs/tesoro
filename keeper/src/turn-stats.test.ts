import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundaryOffsetMs, lateRate, percentile, summarize } from "./turn-stats.ts";

describe("percentile", () => {
  it("interpolates between neighbours (worked example: 1..5)", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 95) - 4.8) < 1e-9);
    assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
    assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  });
  it("is NaN on an empty sample", () => {
    assert.ok(Number.isNaN(percentile([], 50)));
  });
});

describe("summarize", () => {
  it("reports count, median, p95, p99, min and max", () => {
    const s = summarize(Array.from({ length: 101 }, (_, i) => i));
    assert.deepEqual({ n: s.n, min: s.min, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max }, { n: 101, min: 0, p50: 50, p95: 95, p99: 99, max: 100 });
  });
});

describe("lateRate", () => {
  // Each move: the rollup second its turn started and the rollup second its block carries.
  const moves = [
    { turnTs: 100, landedTs: 104 },
    { turnTs: 100, landedTs: 106 },
    { turnTs: 200, landedTs: 206 },
    { turnTs: 300, landedTs: 307 },
    { turnTs: 400, landedTs: 408 },
  ];
  it("counts moves whose clock is past start + turn + grace", () => {
    assert.deepEqual(lateRate(moves, 5, 1), { late: 2, of: 5 });
    assert.deepEqual(lateRate(moves, 5, 0), { late: 4, of: 5 });
    assert.deepEqual(lateRate(moves, 5, 3), { late: 0, of: 5 });
  });
});

describe("boundaryOffsetMs", () => {
  it("is where the rollup's whole second starts on the local clock", () => {
    // Local ms of the first reading that showed each new second; the clock really flips 300 ms after the local second.
    const samples = [
      { ts: 10, seenMs: 10_000 + 350 },
      { ts: 11, seenMs: 11_000 + 320 },
      { ts: 12, seenMs: 12_000 + 380 },
    ];
    // The earliest sighting is the tightest bound: boundary = min(seenMs - ts*1000) = 320.
    assert.equal(boundaryOffsetMs(samples), 320);
  });
});
