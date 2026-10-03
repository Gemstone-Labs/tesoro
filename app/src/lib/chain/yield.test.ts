import { describe, expect, it } from "vitest";
import { MONTH_SECS, SPEEDUP, accruedYield, secondsToAccrue } from "./yield";

describe("per-Position yield", () => {
  const principal = 36_580_000_000n;
  it("accrues an Advance of N months in exactly N * 10 minutes", () => {
    for (const months of [1, 3, 12]) {
      const advance = (principal * 700n * BigInt(months)) / (12n * 10_000n);
      const at = accruedYield({ principal, rateBps: 700, elapsedSec: BigInt(months * MONTH_SECS) });
      expect(at).toBeGreaterThanOrEqual(advance);
      expect(at - advance).toBeLessThan(2n);
    }
  });
  it("is linear in Principal and time", () => {
    const a = accruedYield({ principal, rateBps: 700, elapsedSec: 100n });
    expect(accruedYield({ principal: principal * 2n, rateBps: 700, elapsedSec: 100n }) - a * 2n).toBeLessThan(2n);
    expect(accruedYield({ principal, rateBps: 700, elapsedSec: 200n }) - a * 2n).toBeLessThan(2n);
  });
  it("inverts through secondsToAccrue", () => {
    const units = (principal * 700n * 3n) / (12n * 10_000n);
    expect(secondsToAccrue({ principal, rateBps: 700, units })).toBeLessThanOrEqual(1800);
    expect(secondsToAccrue({ principal: 0n, rateBps: 700, units })).toBeNull();
    expect(SPEEDUP).toBe(4380n);
  });
});
