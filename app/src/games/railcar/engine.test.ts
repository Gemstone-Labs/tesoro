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

describe("worked example", () => {
  it("splits 521 as 313 / 130 / 78", () => {
    expect(split(521n, 3)).toEqual([313n, 130n, 78n]);
  });
});
