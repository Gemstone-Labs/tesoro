import { describe, expect, it } from "vitest";
import vectors from "../../../../programs/railcar/tests/vectors.json";
import legacy from "./vectors-round1.json";
import { MAX_CRASH_MS, MIN_CRASH_MS, RULES_Q39, RULES_Q40, RULES_ROUND1, hexToBytes, impactMs, positionMs, refund, refundAt, refundPct, ride, split } from "./engine";

/** A draw whose first word is `w0` and whose other words are one repeated byte. */
const withWord = (w0: bigint, fill = 0x5a) => {
  const d = new Uint8Array(32).fill(fill);
  for (let i = 0; i < 8; i++) d[i] = Number((w0 >> BigInt(8 * i)) & 0xffn);
  return d;
};
const MAX = (1n << 64n) - 1n;

describe("Rust parity vectors (rules round 2)", () => {
  it("has vectors", () => {
    expect(vectors.rides.length).toBeGreaterThanOrEqual(60);
    expect(vectors.tracks.length).toBeGreaterThan(30);
    expect(vectors.refunds.length).toBeGreaterThan(20);
    expect(vectors.splits.length).toBeGreaterThan(30);
  });

  it.each(vectors.rides.map((v, i) => [i, v] as const))("ride %i", (_i, v) => {
    const r = ride(hexToBytes(v.draw));
    expect(r).toEqual({
      crashMs: v.crash,
      screwLeadMs: v.screwLead,
      boltLeadMs: v.boltLead,
      sparkLeadMs: v.sparkLead,
      screwAtMs: v.screwAt,
      boltAtMs: v.boltAt,
      sparkAtMs: v.sparkAt,
      falseScrews: v.falseScrews,
    });
    expect(ride(hexToBytes(v.draw), { rules: RULES_Q40 })).toEqual(r);
  });

  it.each(vectors.tracks.map((v, i) => [i, v] as const))("track %i", (_i, v) => {
    expect(v.times.map((t) => positionMs(v.brakes, t))).toEqual(v.positions);
    expect(v.crashes.map((c) => impactMs(v.brakes, c))).toEqual(v.impacts);
  });

  it("refunds: none, at every position", () => {
    for (const v of vectors.refunds) {
      expect(v.pct).toBe(0);
      expect(refundPct(v.position)).toBe(0);
      expect(refund(BigInt(v.entry), v.position)).toBe(0n);
      expect(BigInt(v.refund)).toBe(0n);
    }
    expect(refundAt(100n, [30_000], 41_000)).toBe(0n);
  });

  it("splits", () => {
    for (const v of vectors.splits) {
      expect(split(BigInt(v.amount), v.places)).toEqual(v.shares.map(BigInt));
    }
  });
});

describe("the smooth draw's boundaries (decisions Q40)", () => {
  const crash = (w0: bigint) => ride(withWord(w0)).crashMs;

  it("U = 1 and just under give the floor: the safe 5 s and nothing more", () => {
    expect(MIN_CRASH_MS).toBe(5_000);
    expect([crash(MAX), crash(MAX - 1n), crash(MAX - 2n)]).toEqual([5_000, 5_000, 5_000]);
  });

  it("U = 2^-64 and just over give the cap", () => {
    expect(MAX_CRASH_MS).toBe(120_000);
    expect([crash(0n), crash(1n), crash(2n)]).toEqual([120_000, 120_000, 120_000]);
  });

  it("U = 1/2 gives the median: the safe 5 s plus 20 s", () => {
    expect(crash((1n << 63n) - 1n)).toBe(25_000);
  });

  it("the crash point falls as the word grows, and the vectors hold both sides of the cap's edge", () => {
    const capped = vectors.rides.filter((v) => v.crash === 120_000);
    const under = vectors.rides.filter((v) => v.crash < 120_000);
    expect(capped.length).toBeGreaterThanOrEqual(4);
    expect(under.length).toBeGreaterThan(50);
    const words = [0n, 1n, 2n, 1n << 40n, 1n << 50n, (1n << 63n) - 1n, 1n << 63n, MAX - 2n, MAX - 1n, MAX];
    for (let i = 1; i < words.length; i++) expect(crash(words[i - 1])).toBeGreaterThanOrEqual(crash(words[i]));
  });
});

describe("later Tells are not promised (decisions Q39)", () => {
  const rides = vectors.rides.map((v) => ({ v, r: ride(hexToBytes(v.draw)) }));

  it("the vectors hold every pattern: both, the panel only, the sparks only, the screws only", () => {
    const patterns = new Set(rides.map(({ r }) => `${r.boltAtMs !== null}-${r.sparkAtMs !== null}`));
    expect([...patterns].sort()).toEqual(["false-false", "false-true", "true-false", "true-true"]);
  });

  it("a Tell that does not show has no lead and no position; one that shows keeps its round 2 range", () => {
    for (const { r } of rides) {
      expect(r.screwLeadMs >= 9_000 && r.screwLeadMs <= 18_000).toBe(true);
      expect(r.boltLeadMs === null).toBe(r.boltAtMs === null);
      expect(r.sparkLeadMs === null).toBe(r.sparkAtMs === null);
      if (r.boltLeadMs !== null) expect(r.boltLeadMs >= 5_000 && r.boltLeadMs <= 9_000).toBe(true);
      if (r.sparkLeadMs !== null) expect(r.sparkLeadMs >= 3_000 && r.sparkLeadMs <= 5_000 && r.crashMs - r.sparkAtMs! >= 3_000).toBe(true);
      for (const f of r.falseScrews) expect(f >= 1_000 && f <= 9_000 && f + 1_000 <= r.screwAtMs).toBe(true);
    }
  });
});

describe("older cars replay under their own rules (the round 1 Rust engine's vectors, frozen)", () => {
  it.each(legacy.rides.map((v, i) => [i, v] as const))("Q39 ride %i", (_i, v) => {
    const r = ride(hexToBytes(v.draw), { rules: RULES_Q39 });
    expect(r).toEqual({
      crashMs: v.crash,
      screwLeadMs: v.screwLead,
      boltLeadMs: v.boltLead,
      sparkLeadMs: v.sparkLead,
      screwAtMs: v.screwAt,
      boltAtMs: v.boltAt,
      sparkAtMs: v.sparkAt,
      falseScrews: v.falseScrews,
    });
  });

  it("round 1 shows every Tell: the same wall, screws and false screws as Q39, and both later Tells", () => {
    for (const v of legacy.rides) {
      const q39 = ride(hexToBytes(v.draw), { rules: RULES_Q39 });
      const old = ride(hexToBytes(v.draw), { rules: RULES_ROUND1 });
      expect([old.crashMs, old.screwLeadMs, old.screwAtMs, old.falseScrews]).toEqual([q39.crashMs, q39.screwLeadMs, q39.screwAtMs, q39.falseScrews]);
      expect(old.boltLeadMs !== null && old.sparkLeadMs !== null).toBe(true);
      if (q39.boltLeadMs !== null) expect(old.boltLeadMs).toBe(q39.boltLeadMs);
      if (q39.sparkLeadMs !== null) expect(old.sparkLeadMs).toBe(q39.sparkLeadMs);
    }
  });

  it("round 1 and Q39 cars keep the Early-jump refund schedule; the first rides of the old file are what they were", () => {
    for (const v of legacy.refunds) {
      for (const rules of [RULES_ROUND1, RULES_Q39] as const) {
        expect(refundPct(v.position, rules)).toBe(v.pct);
        expect(refund(BigInt(v.entry), v.position, rules)).toBe(BigInt(v.refund));
      }
      expect(refundPct(v.position)).toBe(0);
    }
    const zero = ride(new Uint8Array(32), { rules: RULES_ROUND1 });
    expect([zero.crashMs, zero.screwLeadMs, zero.boltLeadMs, zero.sparkLeadMs, zero.falseScrews]).toEqual([120_000, 20_000, 8_000, 3_000, [14_473, 14_911, 17_651]]);
    const ones = ride(new Uint8Array(32).fill(0xff), { rules: RULES_ROUND1 });
    expect([ones.crashMs, ones.screwLeadMs, ones.boltLeadMs, ones.sparkLeadMs]).toEqual([10_000, 20_594, 10_393, 6_210]);
  });

  it("the track and the split never changed", () => {
    for (const v of legacy.tracks) {
      expect(v.times.map((t) => positionMs(v.brakes, t))).toEqual(v.positions);
      expect(v.crashes.map((c) => impactMs(v.brakes, c))).toEqual(v.impacts);
    }
    for (const v of legacy.splits) expect(split(BigInt(v.amount), v.places)).toEqual(v.shares.map(BigInt));
  });
});

describe("worked example", () => {
  it("splits 170 as 103 / 42 / 25", () => {
    expect(split(170n, 3)).toEqual([103n, 42n, 25n]);
  });
});
