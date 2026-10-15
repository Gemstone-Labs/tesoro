import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import type { PoolParams } from "../../app/src/lib/chain/native.ts";
import { Budget, act, type ActCtx } from "./act.ts";
import { batches, crankGain, crankReason, stakeCrankGain, stakeCustodyRate, type Reading } from "./yield.ts";

// 1 SOL Principal held as 1e9 shares at the constant rate 1.0 (7% APY, 4,380x); an Advance of 80 Gemas at 100,000 lamports per Gema.
const pool: PoolParams = { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4380 };
const source = { issued: 80n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 100_000n, unitDen: 1n };
const reading = (over: Partial<Reading> = {}): Reading => ({ principal: 1_000_000_000n, cumulative: 0n, trackedShares: 1_000_000_000n, redeemedUnits: 0n, source, rateBps: 700, lastAccrualTs: 0, ...over });
/** Milliseconds after `last_accrual_ts`. */
const after = (secs: number) => secs * 1000;

describe("native yield cranks (OC-06)", () => {
  it("computes the Gemas one crank repays, as the program applies it", () => {
    // 1 SOL at 7% earns 5,833,333 lamports per simulated month (600 s) gross; the Position keeps 80% of it, 4,666,666
    // (7,777 per second). The 80 Gemas are an Advance sized on the net yield: 8,000,000 lamports.
    assert.deepEqual(crankGain(reading(), pool, after(0)), { gain: 0n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(36)), { gain: 2n, clears: false });
    assert.deepEqual(crankGain(reading({ cumulative: 280_000n }), pool, after(36)), { gain: 0n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(600)), { gain: 46n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(1031)), { gain: 80n, clears: true });
    assert.deepEqual(crankGain(reading(), pool, after(600), 0), { gain: 58n, clears: false }, "no Yield Fee: the old 100%");
    assert.equal(crankGain(reading({ trackedShares: null }), pool, after(1)), null);
    assert.equal(crankGain(reading({ lastAccrualTs: null }), pool, after(1)), null, "an unmigrated custody");
  });

  it("skips a Position whose crank would repay too little, until it is stale", () => {
    const now = 10_000_000;
    assert.equal(crankReason({ gain: 3n, clears: false }, now - 20_000, now), null, "the old job cranked this every 20 s pass");
    assert.equal(crankReason({ gain: 0n, clears: false }, undefined, now), null);
    assert.match(crankReason({ gain: 3n, clears: false }, now - 600_000, now)!, /periodic/);
    assert.equal(crankReason({ gain: 14n, clears: false }, now - 20_000, now), null, "a fast-growing Position still waits its interval");
    assert.match(crankReason({ gain: 10n, clears: false }, now - 120_000, now)!, /repays 10 Gemas/);
    assert.match(crankReason({ gain: 1n, clears: true }, now - 20_000, now)!, /repays the Debt/);
  });

  it("batches several Positions per transaction, best gain first, and caps a pass", () => {
    const due = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, gain: BigInt(i) }));
    const out = batches(due, new Set(["p19"]), 4, 3);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].map((d) => d.key), ["p19"]);
    assert.deepEqual(out[1].map((d) => d.key), ["p18", "p17", "p16", "p15"]);
    assert.equal(out.flat().length, 9);
  });

  it("stops at the job's share of the hourly cap and leaves the rest to the other jobs", async () => {
    let balance = 10_000_000_000;
    const ctx: ActCtx = {
      settings: { dryRun: false } as ActCtx["settings"],
      budget: new Budget(500_000_000),
      conn: { getBalance: async () => balance } as unknown as ActCtx["conn"],
      payer: Keypair.generate(),
    };
    ctx.budget.observe(balance);
    const share = new Budget(100_000_000);
    const spend = async () => {
      balance -= 60_000_000;
      return "sig";
    };
    assert.equal((await act(ctx, "yield", "-", "crank", spend, share)).ok, true);
    assert.equal((await act(ctx, "yield", "-", "crank", spend, share)).ok, true);
    const third = await act(ctx, "yield", "-", "crank", spend, share);
    assert.deepEqual(third, { ok: false, detail: "budget" });
    assert.equal((await act(ctx, "match", "-", "refund", spend)).ok, true, "a refund still goes through");
  });
});

describe("stake pool custody cranks (ADR 0010)", () => {
  // 10 tokens at 1.2 SOL each, an Advance of 80 Gemas at 100,000 lamports per Gema, the fee settled at 1.2.
  const RATE = 1_200_000_000n;
  const stake = (over: Partial<Reading> = {}) => ({ ...reading({ principal: 12_000_000_000n, trackedShares: 10_000_000_000n, lastAccrualTs: null, ...over }), lastRate: RATE });

  it("repays nothing while the pool rate has not grown", () => {
    assert.deepEqual(stakeCrankGain(stake(), RATE), { gain: 0n, clears: false });
    assert.deepEqual(stakeCrankGain(stake(), RATE - 1n), { gain: 0n, clears: false }, "a rate below its high water mark");
  });

  it("repays the growth net of the Yield Fee the program takes first", () => {
    // 10 tokens gain 0.0005 SOL each = 5,000,000 lamports; the Treasury takes 20%: about 40 Gemas.
    const g = stakeCrankGain(stake(), 1_200_500_000n, 2_000)!;
    assert.ok(g.gain >= 39n && g.gain <= 40n, `gain ${g.gain}`);
    assert.equal(g.clears, false);
    assert.equal(stakeCrankGain(stake(), 1_200_500_000n, 0)!.gain, 50n, "no fee: all of it");
  });

  it("clears the Debt once the growth covers it, and caps the gain at the Debt", () => {
    const g = stakeCrankGain(stake(), 1_230_000_000n, 2_000)!;
    assert.deepEqual(g, { gain: 80n, clears: true });
  });

  it("cannot compute without the Source or the tracked shares", () => {
    assert.equal(stakeCrankGain(stake({ source: null }), 1_300_000_000n), null);
    assert.equal(stakeCrankGain(stake({ trackedShares: null }), 1_300_000_000n), null);
  });

  it("recognises a stake pool custody by its marker and reads the fee rate", () => {
    const legacy = Buffer.alloc(210);
    assert.equal(stakeCustodyRate(legacy), null, "a sim_lst custody has no marker");
    const marked = Buffer.alloc(219);
    marked[210] = 2;
    marked.writeBigUInt64LE(1_234_000_000n, 211);
    assert.equal(stakeCustodyRate(marked), 1_234_000_000n);
    marked[210] = 1;
    assert.equal(stakeCustodyRate(marked), null);
  });
});
