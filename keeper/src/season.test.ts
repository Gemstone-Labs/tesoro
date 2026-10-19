import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { SEASON_EPOCH, SEASON_SECS } from "../../app/src/lib/chain/season.ts";
import { prizeHoldings, seasonPoints, seasonsToCheck, topRanks, type PoolHolding } from "./season.ts";
import type { Standing } from "../../app/src/lib/chain/season.ts";

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

describe("seasonPoints", () => {
  it("encodes each ranked Player's points as a u64 argument", () => {
    const pts = seasonPoints([
      { account: "a", points: 50 },
      { account: "b", points: 35 },
    ] as Standing[]);
    assert.deepEqual(pts.map((p) => p.toString()), ["50", "35"]);
  });
});
