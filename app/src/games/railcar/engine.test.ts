import { describe, expect, it } from "vitest";
import vectors from "../../../../programs/railcar/tests/vectors.json";
import {
  hexToBytes,
  impactMs,
  positionMs,
  refund,
  refundPct,
  ride,
  split,
} from "./engine";

describe("Rust parity vectors", () => {
  it("has vectors", () => {
    expect(vectors.rides.length).toBeGreaterThanOrEqual(60);
    expect(vectors.tracks.length).toBeGreaterThan(30);
    expect(vectors.refunds.length).toBeGreaterThan(100);
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
  });

  it.each(vectors.tracks.map((v, i) => [i, v] as const))(
    "track %i",
    (_i, v) => {
      expect(v.times.map((t) => positionMs(v.brakes, t))).toEqual(v.positions);
      expect(v.crashes.map((c) => impactMs(v.brakes, c))).toEqual(v.impacts);
    },
  );

  it("refunds", () => {
    for (const v of vectors.refunds) {
      expect(refundPct(v.position)).toBe(v.pct);
      expect(refund(BigInt(v.entry), v.position)).toBe(BigInt(v.refund));
    }
  });

  it("splits", () => {
    for (const v of vectors.splits) {
      expect(split(BigInt(v.amount), v.places)).toEqual(v.shares.map(BigInt));
    }
  });
});

describe("later Tells are not promised (decisions Q39)", () => {
  const rides = vectors.rides.map((v) => ({ v, r: ride(hexToBytes(v.draw)) }));

  it("the vectors hold every pattern: both, the panel only, the sparks only, the screws only", () => {
    const patterns = new Set(rides.map(({ r }) => `${r.boltAtMs !== null}-${r.sparkAtMs !== null}`));
    expect([...patterns].sort()).toEqual(["false-false", "false-true", "true-false", "true-true"]);
  });

  it("a Tell that does not show has no lead and no position; one that shows keeps its range", () => {
    for (const { r } of rides) {
      expect(r.boltLeadMs === null).toBe(r.boltAtMs === null);
      expect(r.sparkLeadMs === null).toBe(r.sparkAtMs === null);
      if (r.boltLeadMs !== null) expect(r.boltLeadMs >= 8_000 && r.boltLeadMs <= 15_000).toBe(true);
      if (r.sparkLeadMs !== null) expect(r.sparkLeadMs >= 3_000 && r.sparkLeadMs <= 8_000 && r.crashMs - r.sparkAtMs! >= 3_000).toBe(true);
    }
  });

  it("`everyTell` gives the ride as it was before: the same wall, screws and false screws, and both later Tells", () => {
    for (const { r, v } of rides) {
      const old = ride(hexToBytes(v.draw), { everyTell: true });
      expect([old.crashMs, old.screwLeadMs, old.screwAtMs, old.falseScrews]).toEqual([r.crashMs, r.screwLeadMs, r.screwAtMs, r.falseScrews]);
      expect(old.boltLeadMs !== null && old.sparkLeadMs !== null).toBe(true);
      if (r.boltLeadMs !== null) expect(old.boltLeadMs).toBe(r.boltLeadMs);
      if (r.sparkLeadMs !== null) expect(old.sparkLeadMs).toBe(r.sparkLeadMs);
    }
  });
});

describe("worked example", () => {
  it("splits 521 as 313 / 130 / 78", () => {
    expect(split(521n, 3)).toEqual([313n, 130n, 78n]);
  });
});
