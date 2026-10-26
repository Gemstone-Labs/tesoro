import { describe, expect, it } from "vitest";
import { CORE_UNIT_WEI, MAX_PRINCIPAL_WEI, MIN_PRINCIPAL_WEI, coreUnitsToWei, weiToCoreUnits } from "./eth-units";
import { ethUnlockEstimateMs, parseCorePosition, projectedEthDebt, quoteEthAdvance, quoteEthAdvanceUnits, redeemPayoutWei } from "./eth";
import { PublicKey } from "@solana/web3.js";

const ETH = 10n ** 18n;
const U64 = (1n << 64n) - 1n;
const P2_ACCRUED = 24_330_777_777_777_777_778n; // recorded devnet figure that overflowed u64 wei

describe("wei <-> core units", () => {
  it("floors inbound and multiplies back exactly", () => {
    expect(weiToCoreUnits(CORE_UNIT_WEI - 1n)).toBe(0n);
    expect(weiToCoreUnits(3n * CORE_UNIT_WEI + 5n)).toBe(3n);
    for (const w of [U64 - 1n, U64, U64 + 1n, P2_ACCRUED, 1_000n * ETH]) {
      const u = weiToCoreUnits(w);
      expect(coreUnitsToWei(u)).toBeLessThanOrEqual(w);
      expect(w - coreUnitsToWei(u)).toBeLessThan(CORE_UNIT_WEI);
    }
    expect(weiToCoreUnits(P2_ACCRUED)).toBe(24_330_777_777n);
  });
  it("the Lock range is one core unit up to 2^64 core units", () => {
    expect(MIN_PRINCIPAL_WEI).toBe(1_000_000_000n);
    expect(weiToCoreUnits(MAX_PRINCIPAL_WEI)).toBe(U64);
    expect(weiToCoreUnits(MAX_PRINCIPAL_WEI + CORE_UNIT_WEI)).toBeGreaterThan(U64);
    expect(MAX_PRINCIPAL_WEI).toBeGreaterThan(1_000n * ETH);
  });
});

describe("Advance sizing on core units", () => {
  it("quotes a 1,000 ETH Lock past 2^64 wei", () => {
    // 5% of 1,000 ETH over 12 months = 50 ETH = $150,000 at $3,000 = 15,000,000 Gemas
    expect(quoteEthAdvance(1_000n * ETH, 500, 12, 3_000_000_000n).gemas).toBe(15_000_000n);
    expect(quoteEthAdvanceUnits(1_000n * CORE_UNIT_WEI, 500, 12, 3_000_000_000n).gemas).toBe(15_000_000n);
  });
  it("rounds the principal down to core units first, as the bridge does", () => {
    const wei = 1_074_900_000_000_000_000n + 999_999_999n;
    expect(quoteEthAdvance(wei, 500, 1, 3_000_000_000n)).toEqual(quoteEthAdvanceUnits(weiToCoreUnits(wei), 500, 1, 3_000_000_000n));
  });
});

describe("vault yield (wei) against Source units", () => {
  const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 3_000_000_000n };
  it("projects Debt from accrued wei converted to units", () => {
    // 1 Gema = 10^13 / 3e9 = 3333.33 units; 0.001 ETH = 1e6 units = 300 Gemas
    expect(projectedEthDebt(source, 10n ** 15n)).toBe(1000n - 300n);
    expect(projectedEthDebt(source, 0n)).toBe(1000n);
    expect(projectedEthDebt(source, P2_ACCRUED)).toBe(0n);
  });
  it("estimates the unlock from wei yield per second against unit Debt", () => {
    const rate = { baseRate: ETH, baseTime: 0n, apyBps: 500n, speedup: 1n };
    const position = { heldShares: ETH, principalUnderlying: ETH, paidUnderlying: 0n, accrued: 0n };
    const at = ethUnlockEstimateMs({ source, position, rate, nowMs: 0 });
    // Debt 1000 Gemas ~ 0.00333 ETH; 5% of 1 ETH a year earns that in ~0.0667 years (not 10^9 times off)
    expect(at).not.toBeNull();
    const years = at! / 1000 / (365 * 24 * 3600);
    expect(years).toBeGreaterThan(0.06);
    expect(years).toBeLessThan(0.07);
  });
  it("pays a redeem in wei that is the core units times one gwei", () => {
    const paid = redeemPayoutWei(source, 300n, 0);
    expect(paid % CORE_UNIT_WEI).toBe(0n);
    expect(paid / CORE_UNIT_WEI).toBe((300n * source.unitNum) / source.unitDen);
  });
});

describe("core Position view", () => {
  it("reads the principal as core units", () => {
    const d = new Uint8Array(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 1 + 8 + 8);
    const v = new DataView(d.buffer);
    const o = 8 + 1 + 32 + 32 + 1 + 32 + 1;
    v.setBigUint64(o, 1_000_000_000_000n, true);
    v.setUint16(o + 8, 500, true);
    const view = parseCorePosition(PublicKey.default, d);
    expect(view.principalUnits).toBe(1_000_000_000_000n);
    expect(view.rateBps).toBe(500);
  });
});
