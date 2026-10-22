import { describe, expect, it } from "vitest";
import { readyBy, redeemCost, smallLeftovers } from "./ready-by";

const DAY = 86_400;
const NOW = 1_800_000_000;
const line = (amount: bigint, redeemable: bigint, days: number, classId = 3) => ({ amount, redeemable, dueAt: NOW + days * DAY, classId });

describe("ready by", () => {
  it("separates Gemas ready now from the waiting ones and dates the rest by planned repayment", () => {
    const r = readyBy([line(100n, 100n, -5), line(300n, 50n, 10), line(200n, 0n, 10), line(500n, 0n, 40)], NOW);
    expect(r.now).toBe(150n);
    expect(r.waiting).toBe(950n);
    expect(r.rows).toEqual([
      { at: Math.floor((NOW + 10 * DAY) / DAY) * DAY, gemas: 450n },
      { at: Math.floor((NOW + 40 * DAY) / DAY) * DAY, gemas: 500n },
    ]);
    expect(r.next).toBe(r.rows[0].at);
    expect(r.last).toBe(r.rows[1].at);
  });

  it("folds dates beyond the row limit into the last row and counts overdue as today", () => {
    const r = readyBy([line(10n, 0n, -3), line(10n, 0n, 5), line(10n, 0n, 9), line(10n, 0n, 30), line(10n, 0n, 60)], NOW, 3);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].at).toBe(Math.floor(NOW / DAY) * DAY);
    expect(r.rows[2].gemas).toBe(30n);
    expect(r.waiting).toBe(50n);
  });

  it("ignores fee classes and says nothing is waiting when everything is ready", () => {
    const r = readyBy([line(40n, 0n, 1, 1), line(5n, 5n, 1)], NOW);
    expect(r).toMatchObject({ now: 5n, waiting: 0n, next: null, last: null, rows: [] });
  });
});

describe("small leftovers", () => {
  it("picks small playable lines that have something to redeem", () => {
    const lines = [line(5n, 5n, 0), line(25n, 1n, 0), line(26n, 26n, 0), line(3n, 0n, 0), line(4n, 4n, 0, 1)];
    expect(smallLeftovers(lines)).toEqual([lines[0], lines[1]]);
  });
});

describe("redeem cost", () => {
  it("prices the cross-chain fee against the payout and flags a small Redeem", () => {
    // 0.002 SOL at $150 = $0.30
    const cheap = redeemCost({ feeLamports: 2_000_000n, solMicroUsd: 150_000_000n, redeemGemas: 5_000n });
    expect(cheap.usd).toBeCloseTo(0.3, 5);
    expect(cheap.gemas).toBe(30);
    expect(cheap.small).toBe(false);
    const small = redeemCost({ feeLamports: 2_000_000n, solMicroUsd: 150_000_000n, redeemGemas: 100n });
    expect(small.small).toBe(true);
    expect(small.share).toBeCloseTo(0.3, 5);
  });
});
