import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import type { PoolParams } from "../../app/src/lib/chain/native.ts";
import { Budget, act, type ActCtx } from "./act.ts";
import { batches, crankGain, crankReason, type Reading } from "./yield.ts";

// 1 SOL Principal held as 1e9 shares at the constant rate 1.0 (7% APY, 4,380x); an Advance of 100 Gemas at 100,000 lamports per Gema.
const pool: PoolParams = { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4380 };
const source = { issued: 100n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 100_000n, unitDen: 1n };
const reading = (over: Partial<Reading> = {}): Reading => ({ principal: 1_000_000_000n, cumulative: 0n, trackedShares: 1_000_000_000n, redeemedUnits: 0n, source, rateBps: 700, lastAccrualTs: 0, ...over });
/** Milliseconds after `last_accrual_ts`. */
const after = (secs: number) => secs * 1000;

describe("native yield cranks (OC-06)", () => {
  it("computes the Gemas one crank repays, as the program applies it", () => {
    // 1 SOL at 7% earns 5,833,333 lamports per simulated month (600 s): 9,722 lamports per second.
    assert.deepEqual(crankGain(reading(), pool, after(0)), { gain: 0n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(36)), { gain: 3n, clears: false });
    assert.deepEqual(crankGain(reading({ cumulative: 350_000n }), pool, after(36)), { gain: 0n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(600)), { gain: 58n, clears: false });
    assert.deepEqual(crankGain(reading(), pool, after(1031)), { gain: 100n, clears: true });
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
