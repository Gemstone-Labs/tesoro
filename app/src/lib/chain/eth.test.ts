import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ethPositionId,
  ethUnlockEstimateMs,
  parseEthPositionId,
  projectedEthDebt,
  quoteEthAdvance,
  simRateAt,
  type EthState,
  type SimRate,
} from "./eth";
import { opProgress, type EthOp } from "./eth-track";

const VAULT = "0x6c836b96464B5D1b55536d5a34D023528eaEe4bD";
const rate: SimRate = { baseRate: 10n ** 18n, baseTime: 1_000n, apyBps: 500n, speedup: 4320n };

describe("position id", () => {
  it("round-trips vault and vault id", () => {
    const pid = ethPositionId(VAULT, 7n);
    expect(pid.length).toBe(32);
    expect(parseEthPositionId(pid)).toEqual({ vault: VAULT.toLowerCase(), id: 7n });
  });
});

describe("advance quote", () => {
  it("matches the proven flow: 1 month of 1.0749 ETH at 5% and $3,000 is 1,343 Gemas", () => {
    const q = quoteEthAdvance(1_074_900_000_000_000_000n, 500, 1, 3_000_000_000n);
    expect(q.gemas).toBe(1343n);
  });
});

describe("SimLST clock", () => {
  it("accrues 5% APY at 4,320x: one simulated month per 10 minutes", () => {
    const r = simRateAt(rate, 1_000 + 600);
    // 30 days at 5% APY, simple: 0.05 * 30/365
    expect(Number(r - rate.baseRate) / 1e18).toBeCloseTo((0.05 * 30) / 365, 4);
  });

  it("estimates the unlock time from the Debt and the rate", () => {
    const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 15n, unitDen: 1n };
    const position = { heldShares: 10n ** 18n, principalUnderlying: 10n ** 18n, paidUnderlying: 0n, accrued: 0n };
    const at = ethUnlockEstimateMs({ source, position, rate, nowMs: 1_000_000 });
    // 1e18 wei of yield needed on 1 share: rate must reach baseRate + 1e18 * 1e18 / 1e18 shares... one full unit
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(1_000_000);
    const done = ethUnlockEstimateMs({ source, position: { ...position, accrued: 10n ** 30n }, rate, nowMs: 5 });
    expect(done).toBe(5);
  });

  it("counts only the shares still held after a payout (SP-01)", () => {
    const source = { issued: 2000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 15n, unitDen: 1n };
    const fresh = { heldShares: 10n ** 19n, principalUnderlying: 10n ** 19n, paidUnderlying: 0n, accrued: 0n };
    // 0.5 paid out at rate 1.1: about 0.4545 shares left the vault and no longer earn
    const paidOut = { ...fresh, heldShares: 10n ** 19n - 454_545_454_545_454_545n, paidUnderlying: 5n * 10n ** 17n };
    const a = ethUnlockEstimateMs({ source, position: fresh, rate, nowMs: 0 })!;
    const b = ethUnlockEstimateMs({ source, position: paidOut, rate, nowMs: 0 })!;
    expect(b).toBeGreaterThan(a);
  });

  it("projects the Debt a report would leave", () => {
    const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 100n, unitDen: 1n };
    expect(projectedEthDebt(source, 25_000n)).toBe(750n);
    expect(projectedEthDebt(source, 10n ** 12n)).toBe(0n);
  });
});

const pos = new PublicKey("11111111111111111111111111111111");
const bridge = (over: Partial<NonNullable<EthState["bridge"]>> = {}): NonNullable<EthState["bridge"]> => ({
  lastInSeq: 0n,
  lockedSeq: 0n,
  ownerEvm: "0x0",
  principal: 0n,
  horizonMonths: 1,
  opened: false,
  lastYieldSeq: 0n,
  yieldCumulative: 0n,
  appliedYieldSeq: 0n,
  outSeq: 0n,
  unlockSent: false,
  ...over,
});
const core = (advances = 0): NonNullable<EthState["core"]> => ({ position: pos, principalWei: 1n, rateBps: 500, status: "locked", advances, openAdvance: null, cumulativeYield: 0n });
const st = (over: Partial<EthState>): EthState => ({ bridge: null, core: null, source: null, claim: null, fetchedAt: 0, ...over });
const op = (kind: EthOp["kind"], extra: Partial<EthOp> = {}): EthOp => ({ key: "k", kind, vault: VAULT, id: "1", createdAt: 0, ...extra });

describe("opProgress: pending never shows success early", () => {
  it("open: waits for delivery, then apply_locked, then the Advance, and only then Gemas", () => {
    expect(opProgress(op("open"), st({}), null)).toEqual({ stage: 1, next: null });
    expect(opProgress(op("open"), st({ bridge: bridge() }), null)).toEqual({ stage: 1, next: null });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }) }), null)).toEqual({ stage: 2, next: "apply-locked" });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }), core: core(0) }), null)).toEqual({ stage: 3, next: "advance" });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }), core: core(1) }), null)).toEqual({ stage: 5, next: null });
  });

  it("yield: done only when the new report was applied", () => {
    const o = op("yield", { baseline: "1" });
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 1n, appliedYieldSeq: 1n }) }), null).stage).toBe(1);
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 2n, appliedYieldSeq: 1n }) }), null)).toEqual({ stage: 2, next: "apply-yield" });
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 2n, appliedYieldSeq: 2n }) }), null).stage).toBe(3);
  });

  it("redeem: the send, then the payout on Hoodi", () => {
    const o = op("redeem", { baseline: "500" });
    const vp = (paid: bigint) => ({ paidUnderlying: paid, unlocked: false }) as never;
    const claim = (sent: bigint) => ({ gemasTotal: 1n, unitsTotal: 500n, unitsSent: sent });
    expect(opProgress(o, st({ claim: claim(0n) }), vp(0n))).toEqual({ stage: 1, next: "send-pay-yield" });
    expect(opProgress(o, st({ claim: claim(500n) }), vp(0n))).toEqual({ stage: 2, next: null });
    expect(opProgress(o, st({ claim: claim(500n) }), vp(500n)).stage).toBe(3);
  });

  it("unlock: send, then Principal on Hoodi", () => {
    const o = op("unlock");
    expect(opProgress(o, st({ bridge: bridge() }), { unlocked: false } as never)).toEqual({ stage: 1, next: "send-unlock" });
    expect(opProgress(o, st({ bridge: bridge({ unlockSent: true }) }), { unlocked: false } as never).stage).toBe(2);
    expect(opProgress(o, st({ bridge: bridge({ unlockSent: true }) }), { unlocked: true } as never).stage).toBe(3);
  });
});
