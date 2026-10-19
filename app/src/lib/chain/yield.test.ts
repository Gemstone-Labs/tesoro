import { describe, expect, it } from "vitest";
import fixtures from "./yield-math.fixtures.json";
import { DEFAULT_YIELD_FEE_BPS, MONTH_SECS, SPEEDUP, accruedYield, accruedYieldAt, advanceUnits, growthSinceOpen, instantPayout, netApyPct, netOfYieldFee, positionAccrued, secondsToAccrue, secondsUntilNet } from "./yield";

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

describe("Accrued Yield on the spot (ADR 0010)", () => {
  const T0 = 1_800_000_000;
  it("matches the Rust ledger numbers", () => {
    for (const c of fixtures.accrued) {
      const got = positionAccrued({ principal: BigInt(c.principal), rateBps: c.apyBps, yieldFeeBps: c.feeBps, openedAt: T0 }, fixtures.speedup, T0 + c.elapsed);
      expect([got.gross, got.fee, got.net], JSON.stringify(c)).toEqual([BigInt(c.gross), BigInt(c.fee), BigInt(c.net)]);
    }
  });

  it("splits any growth ratio the way the Rust ledger does", () => {
    for (const c of fixtures.growth) {
      const got = accruedYieldAt(BigInt(c.principal), { num: BigInt(c.num), den: BigInt(c.den) }, c.feeBps);
      expect([got.gross, got.fee, got.net]).toEqual([BigInt(c.gross), BigInt(c.fee), BigInt(c.net)]);
    }
  });

  it("is exactly sim_lst's linear formula and grows by one part in BPS * YEAR", () => {
    const g = growthSinceOpen(495, T0, T0 + 600, 4380);
    expect(g.den).toBe(10_000n * 31_536_000n);
    expect(g.num - g.den).toBe(495n * 600n * 4380n);
  });

  it("finds the second a Position reaches a net yield, to the second", () => {
    const p = { principal: 5_000_000_000n, rateBps: 700, yieldFeeBps: 2000, openedAt: T0 };
    for (const target of [1n, 23_266_667n, 46_666_667n, 1_000_000_000n]) {
      const at = secondsUntilNet(p, 4380, target)!;
      expect(positionAccrued(p, 4380, at).net).toBeGreaterThanOrEqual(target);
      expect(positionAccrued(p, 4380, at - 1).net).toBeLessThan(target);
    }
    expect(secondsUntilNet({ ...p, principal: 0n }, 4380, 1n)).toBeNull();
    expect(secondsUntilNet(p, 4380, 0n)).toBe(T0);
  });
});
