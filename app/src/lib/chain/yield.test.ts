import { describe, expect, it } from "vitest";
import { DEFAULT_YIELD_FEE_BPS, MONTH_SECS, SPEEDUP, accruedYield, advanceUnits, instantPayout, netApyPct, netOfYieldFee, secondsToAccrue } from "./yield";

describe("per-Position yield", () => {
  const principal = 36_580_000_000n;
  it("accrues an Advance of N months in exactly N * 10 minutes, net of the Yield Fee", () => {
    for (const months of [1, 3, 12]) {
      const advance = advanceUnits(principal, 700, months, DEFAULT_YIELD_FEE_BPS);
      const at = netOfYieldFee(accruedYield({ principal, rateBps: 700, elapsedSec: BigInt(months * MONTH_SECS) }), DEFAULT_YIELD_FEE_BPS);
      expect(at).toBeGreaterThanOrEqual(advance);
      expect(at - advance).toBeLessThan(2n);
      expect(secondsToAccrue({ principal, rateBps: 700, units: advance })).toBeLessThanOrEqual(months * MONTH_SECS);
      expect(secondsToAccrue({ principal, rateBps: 700, units: advance })).toBeGreaterThan(months * MONTH_SECS - 2);
    }
  });

  it("sizes an Advance at 80% of the projected yield and floors the fee in the Position's favour", () => {
    expect(advanceUnits(5_000_000_000n, 700, 1, 0)).toBe(29_166_666n);
    expect(advanceUnits(5_000_000_000n, 700, 1, 2_000)).toBe(23_333_333n);
    expect(netOfYieldFee(9n, 2_000)).toBe(8n);
    expect(netOfYieldFee(4n, 2_000)).toBe(4n);
    expect(netApyPct(700, 2_000)).toBeCloseTo(5.6);
  });

  it("pays an Instant Redeem the value less the fee, floored after the unit conversion", () => {
    expect(instantPayout(1_000n, 3_500)).toBe(650n);
    expect(instantPayout(999n, 3_500)).toBe(649n);
    expect(instantPayout(1n, 3_500)).toBe(0n);
  });
  it("is linear in Principal and time", () => {
    const a = accruedYield({ principal, rateBps: 700, elapsedSec: 100n });
    expect(accruedYield({ principal: principal * 2n, rateBps: 700, elapsedSec: 100n }) - a * 2n).toBeLessThan(2n);
    expect(accruedYield({ principal, rateBps: 700, elapsedSec: 200n }) - a * 2n).toBeLessThan(2n);
  });
  it("inverts through secondsToAccrue", () => {
    const units = advanceUnits(principal, 700, 3, DEFAULT_YIELD_FEE_BPS);
    expect(secondsToAccrue({ principal, rateBps: 700, units })).toBeLessThanOrEqual(1800);
    expect(secondsToAccrue({ principal: 0n, rateBps: 700, units })).toBeNull();
    expect(SPEEDUP).toBe(4380n);
  });
});
