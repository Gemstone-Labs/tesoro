import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { PAYOUT_WINDOW_SECS, SEASON_EPOCH, SEASON_SECS } from "../../app/src/lib/chain/season.ts";
import { payPlan, prizeHoldings, seasonsToCheck, topRanks, type PoolHolding } from "./season.ts";

const src = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const holding = (b: number, amount: bigint): PoolHolding => ({ pubkey: src(100 + b), source: src(b), amount });
const win = (player: string, points: number, ts: number) => ({ player, points, ts, matchId: `${player}${ts}` });

describe("season schedule", () => {
  it("looks at finished seasons only, after the grace period", () => {
    const end1 = SEASON_EPOCH + SEASON_SECS;
    assert.deepEqual(seasonsToCheck(SEASON_EPOCH + 5, 600), [], "season 1 is running");
    assert.deepEqual(seasonsToCheck(end1 + 599, 600), [], "ended, still in the grace period");
    assert.deepEqual(seasonsToCheck(end1 + 600, 600), [1]);
    assert.deepEqual(seasonsToCheck(end1 + SEASON_SECS + 700, 600), [1, 2]);
    assert.equal(seasonsToCheck(end1 + 10 * SEASON_SECS + 700, 600, 4).length, 4, "only the last few are checked");
  });
  it("does nothing before the first season", () => {
    assert.deepEqual(seasonsToCheck(SEASON_EPOCH - 1000), []);
  });
});

describe("ranking", () => {
  it("keeps the top ten of the table", () => {
    const wins = Array.from({ length: 14 }, (_, i) => win(`p${String(i).padStart(2, "0")}`, 5 + i, 100 + i));
    const top = topRanks(wins);
    assert.equal(top.length, 10);
    assert.deepEqual([top[0].account, top[0].points, top[9].points], ["p13", 18, 9]);
  });
});

describe("points cap per opponent", () => {
  const w = (player: string, loser: string | undefined, n: number) => ({ player, loser, points: 10, ts: 100 + n, matchId: String(n) });
  it("the 4th win against the same opponent earns 0 Points", () => {
    const wins = [1, 2, 3, 4, 5].map((n) => w("a", "b", n));
    const top = topRanks(wins);
    assert.deepEqual([top[0].points, top[0].wins], [30, 5]);
  });
  it("counts each opponent on its own and by event time, and never caps unnamed losers", () => {
    const wins = [w("a", "c", 9), w("a", "b", 4), w("a", "b", 3), w("a", "b", 2), w("a", "b", 1), w("a", undefined, 5), w("a", undefined, 6), w("a", undefined, 7), w("a", undefined, 8)];
    assert.equal(topRanks(wins)[0].points, 30 + 10 + 40);
  });
  it("a capped win does not move the tie-break", () => {
    const wins = [...[1, 2, 3, 4].map((n) => w("a", "b", n)), w("c", "d", 50), w("c", "d", 51), w("c", "d", 52)];
    assert.deepEqual(topRanks(wins).map((r) => r.account), ["a", "c"]);
  });
});

describe("prize holdings", () => {
  it("drains the pool in Source order, the last one partly", () => {
    const pool = [holding(3, 100n), holding(1, 4n), holding(2, 0n), holding(5, 50n)];
    assert.deepEqual(prizeHoldings(pool, 3n)?.map((h) => h.source.toBase58()), [src(1).toBase58()]);
    assert.deepEqual(prizeHoldings(pool, 4n)?.map((h) => h.source.toBase58()), [src(1).toBase58()], "an exact fit stops at that Holding");
    assert.deepEqual(prizeHoldings(pool, 30n)?.map((h) => h.source.toBase58()), [src(1).toBase58(), src(3).toBase58()]);
    assert.equal(prizeHoldings(pool, 154n)?.length, 3);
    assert.equal(prizeHoldings(pool, 155n), null, "more than the pool holds");
    assert.deepEqual(prizeHoldings(pool, 0n), []);
  });
});

describe("payout window", () => {
  const rec = (over = {}) => ({ count: 4, paidMask: 0, voidedMask: 0, recordedAt: 10_000, ...over });
  const opens = 10_000 + PAYOUT_WINDOW_SECS;
  it("waits 48 hours after the record, then pays every rank", () => {
    assert.deepEqual(payPlan(rec(), 10_001), { kind: "wait", until: opens });
    assert.deepEqual(payPlan(rec(), opens - 1), { kind: "wait", until: opens });
    assert.deepEqual(payPlan(rec(), opens), { kind: "pay", ranks: [0, 1, 2, 3] });
  });
  it("skips voided and paid ranks", () => {
    assert.deepEqual(payPlan(rec({ paidMask: 0b0001, voidedMask: 0b0100 }), opens), { kind: "pay", ranks: [1, 3] });
  });
  it("survives a restart: the plan depends only on the chain record and the clock", () => {
    const onChain = rec({ paidMask: 0b0011 });
    assert.deepEqual(payPlan(onChain, opens + 3600), payPlan({ ...onChain }, opens + 3600));
    assert.deepEqual(payPlan(onChain, opens + 3600), { kind: "pay", ranks: [2, 3] });
  });
  it("leaves a season recorded before the window existed", () => {
    assert.deepEqual(payPlan(rec({ recordedAt: null }), opens * 2), { kind: "legacy" });
  });
});
