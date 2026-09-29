import { describe, expect, it } from "vitest";
import { EntryError, covered, debtGemas, feeGemas, matchDelta, planEntry, redeemableFor, unitsToRepay, type SourceMath } from "./ledger";

// The demo Advance: 7,500 Gemas at $150 (unit = 1e13 / 150e6 lamports per Gema).
const src = (over: Partial<SourceMath> = {}): SourceMath => ({
  issued: 7500n,
  returned: 0n,
  redeemed: 0n,
  yieldUnits: 0n,
  unitNum: 10n ** 13n,
  unitDen: 150_000_000n,
  ...over,
});
const key = (n: number) => Uint8Array.from({ length: 32 }, () => n);

describe("source math", () => {
  it("has full Debt and nothing redeemable before any yield", () => {
    expect(debtGemas(src())).toBe(7500n);
    expect(redeemableFor(src(), 7500n)).toBe(0n);
  });

  it("20% of the repayment yield covers 1,500 Gemas, redeemable pro rata", () => {
    const need = unitsToRepay(src());
    expect(need).toBe(500_000_000n);
    const s = src({ yieldUnits: (need * 20n) / 100n });
    expect(covered(s)).toBe(1500n);
    expect(debtGemas(s)).toBe(6000n);
    expect(redeemableFor(s, 7500n)).toBe(1500n);
    expect(redeemableFor(s, 3750n)).toBe(750n);
  });
});

describe("planEntry", () => {
  const h = (n: number, isOwn: boolean, free: bigint) => ({ source: key(n), isOwn, free });

  it("draws own-sourced Gemas first", () => {
    expect(planEntry(1000n, [h(1, false, 5000n), h(2, true, 5000n)])).toEqual([1]);
  });

  it("tops up from won Gemas, own class first", () => {
    expect(planEntry(1000n, [h(9, false, 5000n), h(2, true, 400n)])).toEqual([1, 0]);
  });

  it("orders each class ascending by Source", () => {
    expect(planEntry(1000n, [h(7, true, 600n), h(3, true, 600n)])).toEqual([1, 0]);
  });

  it("refuses when Gemas are short or would need more than 2 Sources", () => {
    expect(() => planEntry(1000n, [h(1, true, 999n)])).toThrow(EntryError);
    expect(() => planEntry(1000n, [h(1, true, 400n), h(2, true, 400n), h(3, true, 400n)])).toThrow(/2 Sources/);
  });
});

describe("match outcome", () => {
  const fees = { platformBps: 200, studioBps: 300 };
  it("takes 5% of the Pot from the loser's side", () => {
    expect(feeGemas(1000n, 200, 300)).toBe(100n);
    const m = { seat: 0 as const, entry: 1000, fees, session: { settled: true, result: "opener" as const } };
    expect(matchDelta(m)).toBe(900);
    expect(matchDelta({ ...m, seat: 1 })).toBe(-1000);
    expect(matchDelta({ ...m, session: { settled: true, result: "draw" } })).toBe(0);
    expect(matchDelta({ ...m, session: { settled: false, result: "opener" } })).toBe(0);
  });
});
