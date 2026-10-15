import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import {
  accrueNativeYieldIx,
  extendNativeAdvanceIx,
  faucetIx,
  openNativePositionIx,
  positionPda,
  projectedDebtGemas,
  quoteExtendAdvance,
  quoteNativeAdvance,
  rateAt,
  setEntryLimitIx,
  setExtendLimitIx,
  redeemIx,
  redeemPayoutShares,
  fundTreasuryIx,
  initTreasuryIx,
  instantRedeemIx,
  redeemTreasuryIx,
  setPriceIx,
  sourcePda,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  unlockEstimateMs,
  unlockIx,
  type PoolParams,
  RATE_SCALE,
  surplusShares,
  treasuryPda,
  treasuryVaultPda,
} from "./native";

const owner = new PublicKey("AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV");
const pool: PoolParams = { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4380 };

describe("native instructions", () => {
  it("uses Anchor discriminators sha256('global:<name>')[..8]", () => {
    const d = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex");
    const pos = sourcePda(owner, 0);
    const cases: [Buffer, string][] = [
      [faucetIx(owner).data, "faucet"],
      [setPriceIx(owner, 1n).data, "set_price"],
      [openNativePositionIx(owner, 1, 1n, pos).data, "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 0, 3).data, "take_native_advance"],
      [extendNativeAdvanceIx(owner, pos, 0, 3).data, "extend_native_advance"],
      [setExtendLimitIx(owner, 2).data, "set_extend_limit"],
      [setEntryLimitIx(owner, 500).data, "set_entry_limit"],
      [accrueNativeYieldIx(pos, null).data, "accrue_native_yield"],
      [redeemIx(owner, pos, pos, 1n).data, "redeem"],
      [unlockIx(owner, pos).data, "unlock"],
      [sweepNativeSurplusIx(owner, pos).data, "sweep_native_surplus"],
      [initTreasuryIx(owner, 2000, 3500).data, "init_treasury"],
      [fundTreasuryIx(owner, 1n).data, "fund_treasury"],
      [instantRedeemIx(owner, pos, pos, 1n).data, "instant_redeem"],
      [redeemTreasuryIx(pos, pos, 1n).data, "redeem_treasury"],
    ];
    for (const [data, name] of cases) expect(data.subarray(0, 8).toString("hex"), name).toBe(d(name));
  });

  it("marks accounts writable and signer exactly as the IDL says (a read-only custody made sweep fail with ConstraintMut)", () => {
    const pos = sourcePda(owner, 0);
    const cases: [ReturnType<typeof unlockIx>, string][] = [
      [sweepNativeSurplusIx(owner, pos), "sweep_native_surplus"],
      [accrueNativeYieldIx(pos, 0), "accrue_native_yield"],
      [redeemIx(owner, pos, pos, 1n), "redeem"],
      [unlockIx(owner, pos), "unlock"],
      [openNativePositionIx(owner, 1, 1n, pos), "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 0, 3), "take_native_advance"],
      [extendNativeAdvanceIx(owner, pos, 0, 3), "extend_native_advance"],
      [setExtendLimitIx(owner, 2), "set_extend_limit"],
      [setEntryLimitIx(owner, 500), "set_entry_limit"],
      [initTreasuryIx(owner, 2000, 3500), "init_treasury"],
      [fundTreasuryIx(owner, 1n), "fund_treasury"],
      [instantRedeemIx(owner, pos, pos, 1n), "instant_redeem"],
      [redeemTreasuryIx(pos, pos, 1n), "redeem_treasury"],
    ];
    for (const [ix, name] of cases) {
      const spec = (idl.instructions as { name: string; accounts: { writable?: boolean; signer?: boolean }[] }[]).find((i) => i.name === name);
      expect(spec, name).toBeDefined();
      spec!.accounts.forEach((a, i) => {
        if (!ix.keys[i]) return;
        expect(ix.keys[i].isWritable, `${name} account #${i}`).toBe(!!a.writable);
        expect(ix.keys[i].isSigner, `${name} account #${i} signer`).toBe(!!a.signer);
      });
    }
  });

  it("lists exactly the accounts the IDL lists for the Treasury instructions, the treasury where the program expects it", () => {
    const pos = sourcePda(owner, 0);
    const count = (name: string) => (idl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === name)!.accounts.length;
    expect(accrueNativeYieldIx(pos, 0).keys).toHaveLength(count("accrue_native_yield"));
    expect(takeNativeAdvanceIx(owner, pos, 0, 3).keys).toHaveLength(count("take_native_advance"));
    expect(instantRedeemIx(owner, pos, pos, 1n).keys).toHaveLength(count("instant_redeem"));
    expect(initTreasuryIx(owner, 2000, 3500).keys).toHaveLength(count("init_treasury"));
    expect(fundTreasuryIx(owner, 1n).keys).toHaveLength(count("fund_treasury"));
    expect(redeemTreasuryIx(pos, pos, 1n).keys).toHaveLength(count("redeem_treasury") + 5);
    expect(takeNativeAdvanceIx(owner, pos, 0, 3).keys[4].pubkey.equals(treasuryPda())).toBe(true);
    expect(accrueNativeYieldIx(pos, null).keys[9].pubkey.equals(treasuryPda())).toBe(true);
    expect(accrueNativeYieldIx(pos, null).keys[10].pubkey.equals(treasuryVaultPda())).toBe(true);
    expect(initTreasuryIx(owner, 2000, 3500).data.subarray(8).toString("hex")).toBe("d007ac0d");
  });

  it("extend_native_advance lists the IDL accounts, carries the months, and derives the Source and Holding PDAs", () => {
    const pos = sourcePda(owner, 0);
    const ix = extendNativeAdvanceIx(owner, pos, 2, 4);
    const spec = (idl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === "extend_native_advance")!;
    expect(ix.keys).toHaveLength(spec.accounts.length);
    expect(ix.data.subarray(8).toString("hex")).toBe("04");
    expect(ix.keys[3].pubkey.equals(treasuryPda())).toBe(true);
    expect(ix.keys[4].pubkey.equals(sourcePda(pos, 2))).toBe(true);
  });

  it("redeem and unlock carry the five payout accounts", () => {
    const pos = sourcePda(owner, 0);
    expect(redeemIx(owner, pos, pos, 5n).keys).toHaveLength(5 + 5);
    expect(unlockIx(owner, pos).keys).toHaveLength(3 + 5);
  });

  it("derives the devnet Position of the deployer (nonce 1)", async () => {
    expect((await positionPda(owner, 1)).toBase58()).toBe("2QxKeDKJfWvGa6uNwXG6533ZpNTazyoUEXj4ALRj2Zb6");
  });
});

describe("native math", () => {
  it("sizes an Advance like the program (5 SOL, 7%, 1 month, $150)", () => {
    const q = quoteNativeAdvance(5_000_000_000n, 700, 1, 150_000_000n, 0);
    expect(q.projectedUnits).toBe(29_166_666n);
    expect(q.gemas).toBe(437n);
  });

  it("is 80% of that after the Yield Fee, and still repaid in 10 minutes per month", () => {
    const q = quoteNativeAdvance(5_000_000_000n, 700, 1, 150_000_000n);
    expect(q.projectedUnits).toBe(23_333_333n);
    expect(q.gemas).toBe(349n);
  });

  it("keeps the rate constant: yield is per Position, not in the rate", () => {
    expect(rateAt(pool)).toBe(pool.baseRate);
    expect(rateAt(pool)).toBe(pool.baseRate);
  });

  const source = { issued: 349n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 150_000_000n };
  const vault = 5_000_000_000n;

  it("projects Debt down and the Unlock Estimate forward", () => {
    const clock = { rateBps: 700, lastAccrualTs: 0 };
    const args = { source, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool, clock };
    const debt0 = projectedDebtGemas(source, vault, 0n, vault, pool, 0, clock);
    const debt5 = projectedDebtGemas(source, vault, 0n, vault, pool, 300_000, clock);
    expect(debt0).toBe(349n);
    expect(debt5 < debt0).toBe(true);
    // A 1-month Advance is repaid in 10 minutes.
    const at = unlockEstimateMs({ ...args, nowMs: 0 })!;
    expect(at).toBeGreaterThanOrEqual(599_000);
    expect(at).toBeLessThanOrEqual(601_000);
    expect(projectedDebtGemas(source, vault, 0n, vault, pool, at + 5_000, clock)).toBe(0n);
    // Yield already minted into the vault counts, and yield not yet minted is projected.
    const minted = unlockEstimateMs({ ...args, vaultShares: vault + 14_583_333n, principalLamports: vault, nowMs: 300_000 })!;
    expect(minted).toBeLessThan(at + 1);
  });

  it("has no estimate without an Advance and 'now' when already repaid", () => {
    expect(unlockEstimateMs({ source: null, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool, clock: { rateBps: 700, lastAccrualTs: 0 }, nowMs: 0 })).toBeNull();
    expect(unlockEstimateMs({ source: { ...source, yieldUnits: 10n ** 12n }, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool, clock: { rateBps: 700, lastAccrualTs: 0 }, nowMs: 42 })).toBe(42);
  });

  it("pays simSOL worth the redeemed units", () => {
    // 15,000 Gemas = $150 = 1 SOL of units; at rate 1.25 that is 0.8 simSOL
    expect(redeemPayoutShares(source, 15_000n, 1_250_000_000n)).toBe(800_000_000n);
  });
});

describe("surplusShares", () => {
  const base = { vaultShares: 1_000_000n, cumulativeYield: 500_000n, freeYield: 100_000n, redeemedUnits: 150_000n };
  it("is 0 while Locked", () => {
    expect(surplusShares({ ...base, status: "locked" }, RATE_SCALE)).toBe(0n);
  });
  it("keeps the yield still owed to holders, rounded up", () => {
    // owed 250,000 units at rate 2.0 → 125,000 shares required.
    expect(surplusShares({ ...base, status: "unlocked" }, 2n * RATE_SCALE)).toBe(875_000n);
    // owed 250,000 at rate 3.0 → 83,333.3 rounds up to 83,334.
    expect(surplusShares({ ...base, status: "unlocked" }, 3n * RATE_SCALE)).toBe(916_666n);
  });
  it("is 0 once swept", () => {
    expect(surplusShares({ ...base, vaultShares: 125_000n, status: "unlocked" }, 2n * RATE_SCALE)).toBe(0n);
  });
});

describe("extend an Advance", () => {
  const price = 150_000_000n;
  const principal = 5_000_000_000n;
  const first = quoteNativeAdvance(principal, 700, 3, price, 2000);
  const source = { issued: first.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: price };

  it("mints the added months at the current fee when the fee changed since the Advance", () => {
    const quote = quoteExtendAdvance(principal, 700, source, 3, 3, 0);
    const size = (months: number) => quoteNativeAdvance(principal, 700, months, price, 0).gemas;
    expect(quote.gemas).toBe(size(6) - size(3));
    expect(quote.gemas).toBeGreaterThan(0n);
  });

  it("mints the added months at an unchanged fee, so two extensions equal one", () => {
    const once = quoteExtendAdvance(principal, 700, source, 3, 6, 2000);
    expect(once.gemas).toBe(quoteNativeAdvance(principal, 700, 9, price, 2000).gemas - first.gemas);
    const a = quoteExtendAdvance(principal, 700, source, 3, 3, 2000);
    const b = quoteExtendAdvance(principal, 700, a.extended, 6, 3, 2000);
    expect(a.gemas + b.gemas).toBe(once.gemas);
    expect(b.extended.issued).toBe(source.issued + once.gemas);
  });
});
