import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import {
  accrueNativeYieldIx,
  faucetIx,
  openNativePositionIx,
  positionPda,
  projectedDebtGemas,
  quoteNativeAdvance,
  rateAt,
  redeemIx,
  redeemPayoutShares,
  setPriceIx,
  sourcePda,
  sweepNativeSurplusIx,
  takeNativeAdvanceIx,
  unlockEstimateMs,
  unlockIx,
  type PoolParams,
} from "./native";

const owner = new PublicKey("AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV");
const pool: PoolParams = { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4320 };

describe("native instructions", () => {
  it("uses Anchor discriminators sha256('global:<name>')[..8]", () => {
    const d = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex");
    const pos = sourcePda(owner, 0);
    const cases: [Buffer, string][] = [
      [faucetIx(owner).data, "faucet"],
      [setPriceIx(owner, 1n).data, "set_price"],
      [openNativePositionIx(owner, 1, 1n, pos).data, "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 0, 3).data, "take_native_advance"],
      [accrueNativeYieldIx(pos, null).data, "accrue_native_yield"],
      [redeemIx(owner, pos, pos, 1n).data, "redeem"],
      [unlockIx(owner, pos).data, "unlock"],
      [sweepNativeSurplusIx(owner, pos).data, "sweep_native_surplus"],
    ];
    for (const [data, name] of cases) expect(data.subarray(0, 8).toString("hex"), name).toBe(d(name));
  });

  it("marks accounts writable and signer exactly as the IDL says (a read-only custody made sweep fail with ConstraintMut)", () => {
    const pos = sourcePda(owner, 0);
    const cases: [ReturnType<typeof unlockIx>, string][] = [
      [sweepNativeSurplusIx(owner, pos), "sweep_native_surplus"],
      [accrueNativeYieldIx(pos, pos), "accrue_native_yield"],
      [redeemIx(owner, pos, pos, 1n), "redeem"],
      [unlockIx(owner, pos), "unlock"],
      [openNativePositionIx(owner, 1, 1n, pos), "open_native_position"],
      [takeNativeAdvanceIx(owner, pos, 0, 3), "take_native_advance"],
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
    const q = quoteNativeAdvance(5_000_000_000n, 700, 1, 150_000_000n);
    expect(q.projectedUnits).toBe(29_166_666n);
    expect(q.gemas).toBe(437n);
  });

  it("rate grows 1 month of yield per 10 minutes", () => {
    const r = rateAt(pool, 600);
    expect(Number(r - 1_000_000_000n) / 1e9).toBeCloseTo((0.07 * (600 * 4320)) / 31_536_000, 6);
  });

  const source = { issued: 437n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: 150_000_000n };
  const vault = 5_000_000_000n;

  it("projects Debt down and the Unlock Estimate forward", () => {
    const args = { source, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool };
    const debt0 = projectedDebtGemas(source, vault, 0n, vault, pool, 0);
    const debt5 = projectedDebtGemas(source, vault, 0n, vault, pool, 300_000);
    expect(debt0).toBe(437n);
    expect(debt5 < debt0).toBe(true);
    const at = unlockEstimateMs({ ...args, nowMs: 0 })!;
    expect(at).toBeGreaterThan(9 * 60_000);
    expect(at).toBeLessThan(12 * 60_000);
    expect(projectedDebtGemas(source, vault, 0n, vault, pool, at + 5_000)).toBe(0n);
  });

  it("has no estimate without an Advance and 'now' when already repaid", () => {
    expect(unlockEstimateMs({ source: null, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool, nowMs: 0 })).toBeNull();
    expect(unlockEstimateMs({ source: { ...source, yieldUnits: 10n ** 12n }, vaultShares: vault, redeemedUnits: 0n, principalLamports: vault, pool, nowMs: 42 })).toBe(42);
  });

  it("pays simSOL worth the redeemed units", () => {
    // 15,000 Gemas = $150 = 1 SOL of units; at rate 1.25 that is 0.8 simSOL
    expect(redeemPayoutShares(source, 15_000n, 1_250_000_000n)).toBe(800_000_000n);
  });
});
