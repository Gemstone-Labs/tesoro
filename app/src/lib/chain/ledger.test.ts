import { describe, expect, it } from "vitest";
import fixtures from "./yield-math.fixtures.json";
import { backedSplit, gemasInAsset, backerDelta, covered, debtGemas, feeGemas, instantSplit, matchDelta, redeemable, redeemableFor, returnableGemas, seatResult, sourceNow, sourceView, unitsToRepay, unitsToRepayTotal, type SourceMath } from "./ledger";

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

  it("Instant Redeem sells only what is still pending, after the landed part is redeemed", () => {
    const s = src({ yieldUnits: unitsToRepay(src()) / 2n });
    // A sole holder: half landed, the other half pending.
    expect(instantSplit(s, 7500n)).toEqual({ landed: 3750n, pending: 3750n });
    // With other holders the remainder keeps a pro rata share of what landed, so less is pending.
    expect(instantSplit(s, 3750n)).toEqual({ landed: 1875n, pending: 1250n });
    expect(instantSplit(src(), 900n)).toEqual({ landed: 0n, pending: 900n });
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

describe("backed settlement", () => {
  const fees = { platformBps: 200, studioBps: 300 };
  const won = { entry: 1000, ...fees, shareBps: 4000, won: true };
  it("returns the Backer's entry first, then splits the surplus after Fees", () => {
    // Pot 2,000, Fees 100 from the loser's 1,000, surplus 900: Player 40% = 360, Backer 540.
    expect(backedSplit(won)).toEqual({
      fees: 100,
      surplus: 900,
      playerShare: 360,
      backerEntryBack: 1000,
      backerSurplus: 540,
      backerNet: 540,
      playerNet: 360,
    });
  });
  it("on a loss the Backer bears the entry and the Player gains nothing", () => {
    const s = backedSplit({ ...won, won: false });
    expect(s.backerNet).toBe(-1000);
    expect(s.playerNet).toBe(0);
  });
  it("derives each party's delta from the settled result", () => {
    const m = { entry: 1000, fees, shareBps: 4000, session: { settled: true, result: "opener" as const } };
    expect(matchDelta({ ...m, seat: 0, backing: { shareBps: 4000 } })).toBe(360);
    expect(matchDelta({ ...m, seat: 1, backing: { shareBps: 4000 } })).toBe(0);
    expect(backerDelta({ ...m, backerSeat: 0 })).toBe(540);
    expect(backerDelta({ ...m, backerSeat: 1 })).toBe(-1000);
    expect(backerDelta({ ...m, backerSeat: 1, session: { settled: true, result: "draw" } })).toBe(0);
  });
});

describe("returnableGemas", () => {
  const me = "Me111";
  const row = (over: Partial<Parameters<typeof returnableGemas>[0]> = {}) => ({ isOwn: true, sourceOwner: me, amount: 3000n, reserved: 0n, sourceDebt: 7500n, ...over });

  it("allows the owner's free own-Sourced Gemas", () => {
    expect(returnableGemas(row(), me)).toBe(3000n);
  });

  it("caps at the Source's Debt", () => {
    expect(returnableGemas(row({ sourceDebt: 1200n }), me)).toBe(1200n);
    expect(returnableGemas(row({ sourceDebt: 0n }), me)).toBe(0n);
  });

  it("excludes won Gemas", () => {
    expect(returnableGemas(row({ isOwn: false, sourceOwner: "Them1" }), me)).toBe(0n);
  });

  it("excludes foreign-Sourced Gemas even if flagged own", () => {
    expect(returnableGemas(row({ sourceOwner: "Them1" }), me)).toBe(0n);
  });

  it("excludes reserved Gemas", () => {
    expect(returnableGemas(row({ reserved: 1000n }), me)).toBe(2000n);
    expect(returnableGemas(row({ reserved: 3000n }), me)).toBe(0n);
  });
});

describe("backed Player's result", () => {
  const fees = { platformBps: 200, studioBps: 300 };
  const lost = { seat: 1 as const, entry: 1000, fees, backing: { shareBps: 4000 }, session: { settled: true, result: "opener" as const } };
  it("a backed loss is a loss that costs the Player 0 Gemas", () => {
    expect(seatResult(lost, 1)).toBe("lost");
    expect(matchDelta(lost)).toBe(0);
  });
  it("a backed win at a 0% share is still a win", () => {
    const m = { ...lost, seat: 0 as const, backing: { shareBps: 0 } };
    expect(seatResult(m, 0)).toBe("won");
    expect(matchDelta(m)).toBe(0);
  });
  it("has no result before settlement, and a draw for either seat", () => {
    expect(seatResult({ session: { settled: false, result: "opener" } }, 0)).toBeNull();
    expect(seatResult({ session: null, winner: null }, 0)).toBeNull();
    expect(seatResult({ session: null, winner: "joiner" }, 1)).toBe("won");
    expect(seatResult({ session: { settled: true, result: "draw" } }, 1)).toBe("draw");
  });
});

describe("gemasInAsset", () => {
  it("values Gemas at the Advance price, $0.01 each", () => {
    expect(gemasInAsset(7500n, { unitDen: 150_000_000n })).toBeCloseTo(0.5); // $75 of SOL at $150
    expect(gemasInAsset(620n, { unitDen: 3_000_000_000n })).toBeCloseTo(0.0020667, 6); // $6.20 of ETH at $3,000
    expect(gemasInAsset(100n, { unitDen: 0n })).toBe(0);
  });
});

describe("Source at the clock (ADR 0010)", () => {
  const f = fixtures.source;
  const source: SourceMath = { issued: BigInt(f.issued), returned: BigInt(f.returned), redeemed: BigInt(f.redeemed), yieldUnits: 0n, unitNum: BigInt(f.unitNum), unitDen: BigInt(f.unitDen) };

  it("owes what the Rust ledger says to repay everything live", () => {
    expect(unitsToRepayTotal(source)).toBe(BigInt(f.owedTotal));
  });

  it("matches the Rust ledger for Debt, redeemable and free yield", () => {
    for (const c of fixtures.sourceNow) {
      const now = sourceNow(source, BigInt(c.net), BigInt(c.applied));
      expect(now.source.yieldUnits, JSON.stringify(c)).toBe(BigInt(c.yieldUnits));
      expect(debtGemas(now.source)).toBe(BigInt(c.debt));
      expect(redeemable(now.source)).toBe(BigInt(c.redeemable));
      expect(now.freeUnits).toBe(BigInt(c.free));
    }
  });

  it("derives only the open Advance, never lowers a stored yield, and reads a closed Source as stored", () => {
    const open = { openAdvance: 2, appliedNet: 30_000_000n };
    expect(sourceView(open, 2, source, 50_000_000n).yieldUnits).toBe(20_000_000n);
    expect(sourceView(open, 2, { ...source, yieldUnits: 25_000_000n }, 50_000_000n).yieldUnits).toBe(25_000_000n);
    expect(sourceView(open, 1, { ...source, yieldUnits: 9n }, 999_000_000n).yieldUnits).toBe(9n);
    expect(sourceView({ openAdvance: null, appliedNet: 0n }, 2, source, 999_000_000n).yieldUnits).toBe(0n);
  });
});

