import { describe, expect, it } from "vitest";
import fixtures from "./yield-math.fixtures.json";
import { MONTH_SECS, SPEEDUP, accruedYield, accruedYieldAt, advanceUnits, cashOut, growthSinceOpen, instantPayout, positionAccrued, secondsToAccrue, secondsUntilNet, treasuryCashOut } from "./yield";

describe("per-Position yield", () => {
  const principal = 36_580_000_000n;
  it("accrues an Advance of N months in exactly N * 10 minutes: Gemas are the whole yield", () => {
    for (const months of [1, 3, 12]) {
      const advance = advanceUnits(principal, 700, months);
      const at = accruedYield({ principal, rateBps: 700, elapsedSec: BigInt(months * MONTH_SECS) });
      expect(at).toBeGreaterThanOrEqual(advance);
      expect(at - advance).toBeLessThan(2n);
      expect(secondsToAccrue({ principal, rateBps: 700, units: advance })).toBeLessThanOrEqual(months * MONTH_SECS);
      expect(secondsToAccrue({ principal, rateBps: 700, units: advance })).toBeGreaterThan(months * MONTH_SECS - 2);
    }
  });

  it("sizes an Advance on the whole projected yield (ticket 31)", () => {
    expect(advanceUnits(5_000_000_000n, 700, 1)).toBe(29_166_666n);
  });

  it("is linear in Principal and time", () => {
    const a = accruedYield({ principal, rateBps: 700, elapsedSec: 100n });
    expect(accruedYield({ principal: principal * 2n, rateBps: 700, elapsedSec: 100n }) - a * 2n).toBeLessThan(2n);
    expect(accruedYield({ principal, rateBps: 700, elapsedSec: 200n }) - a * 2n).toBeLessThan(2n);
  });
  it("inverts through secondsToAccrue", () => {
    const units = advanceUnits(principal, 700, 3);
    expect(secondsToAccrue({ principal, rateBps: 700, units })).toBeLessThanOrEqual(1800);
    expect(secondsToAccrue({ principal: 0n, rateBps: 700, units })).toBeNull();
    expect(SPEEDUP).toBe(4380n);
  });
});

describe("the Yield Fee at cash-out (ledger/yield_fee.rs)", () => {
  it("splits a Redeem with one floor, exactly as the Rust ledger", () => {
    for (const c of fixtures.cashOut) {
      const got = cashOut(BigInt(c.paid), c.yieldFeeBps, c.poolBps);
      expect([got.payout, got.fee, got.pool], JSON.stringify(c)).toEqual([BigInt(c.payout), BigInt(c.fee), BigInt(c.pool)]);
    }
  });

  it("pays an Instant Redeem the value after both fees, one floor", () => {
    for (const c of fixtures.instantPayout) {
      expect(instantPayout(BigInt(c.value), c.instantFeeBps, c.yieldFeeBps), JSON.stringify(c)).toBe(BigInt(c.payout));
    }
  });

  it("owes the Pool its fee half and a fifth of the Instant fee when the Treasury redeems", () => {
    for (const c of fixtures.treasuryCashOut) {
      const got = treasuryCashOut(BigInt(c.paid), c.yieldFeeBps, c.poolBps, c.instantFeeBps);
      expect([got.payout, got.fee, got.pool], JSON.stringify(c)).toEqual([BigInt(c.payout), BigInt(c.fee), BigInt(c.pool)]);
    }
  });
});

describe("Accrued Yield on the spot (ADR 0010)", () => {
  const T0 = 1_800_000_000;
  it("matches the Rust ledger numbers", () => {
    for (const c of fixtures.accrued) {
      const got = positionAccrued({ principal: BigInt(c.principal), rateBps: c.apyBps, openedAt: T0 }, fixtures.speedup, T0 + c.elapsed);
      expect(got, JSON.stringify(c)).toBe(BigInt(c.gross));
    }
  });

  it("floors any growth ratio the way the Rust ledger does", () => {
    for (const c of fixtures.growth) {
      expect(accruedYieldAt(BigInt(c.principal), { num: BigInt(c.num), den: BigInt(c.den) })).toBe(BigInt(c.gross));
    }
  });

  it("is exactly sim_lst's linear formula and grows by one part in BPS * YEAR", () => {
    const g = growthSinceOpen(495, T0, T0 + 600, 4380);
    expect(g.den).toBe(10_000n * 31_536_000n);
    expect(g.num - g.den).toBe(495n * 600n * 4380n);
  });

  it("finds the second a Position reaches an Accrued Yield, to the second", () => {
    const p = { principal: 5_000_000_000n, rateBps: 700, openedAt: T0 };
    for (const target of [1n, 23_266_667n, 46_666_667n, 1_000_000_000n]) {
      const at = secondsUntilNet(p, 4380, target)!;
      expect(positionAccrued(p, 4380, at)).toBeGreaterThanOrEqual(target);
      expect(positionAccrued(p, 4380, at - 1)).toBeLessThan(target);
    }
    expect(secondsUntilNet({ ...p, principal: 0n }, 4380, 1n)).toBeNull();
    expect(secondsUntilNet(p, 4380, 0n)).toBe(T0);
  });
});
