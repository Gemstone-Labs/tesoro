import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import type { Ctx } from "./act.ts";
import { FastLane, burstWork, nextTurn } from "./lanes.ts";

const match = (stage: string, game = BLOCK_PUZZLE_PROGRAM_ID) => ({ address: Keypair.generate().publicKey, stage, inner: { game: Array.from(game.toBytes()) } });
const other = Keypair.generate().publicKey;

test("the fast lane is due first only when its time is before the full pass", () => {
  assert.equal(nextTurn({ fullAt: 100, fastAt: 90 }), "fast");
  assert.equal(nextTurn({ fullAt: 100, fastAt: 100 }), "full");
  assert.equal(nextTurn({ fullAt: 100, fastAt: 110 }), "full");
  assert.equal(nextTurn({ fullAt: 100, fastAt: null }), "full");
});

test("Block Burst work is a joined Match that is not closed away; an open one waits for no operator step", () => {
  assert.deepEqual(burstWork([match("open")]), []);
  for (const stage of ["active", "settling", "refunding", "closed"]) assert.equal(burstWork([match(stage)]).length, 1, stage);
  assert.deepEqual(burstWork([match("active", other)]), []);
  assert.deepEqual(burstWork([]), []);
});

function lane(matches: ReturnType<typeof match>[]) {
  const ran: string[] = [];
  let scans = 0;
  let observed = 0;
  const fast = new FastLane({
    scan: async () => (scans++, matches),
    clock: async () => 1_000,
    hotMs: 20_000,
    quietMs: 300_000,
    observe: async () => void observed++,
    jobs: ["tables", "match", "history"].map((n) => [n, async () => (ran.push(n), 0)] as [string, (c: Ctx) => Promise<number>]),
  });
  return { fast, ran, scans: () => scans, observed: () => observed };
}

test("with no Block Burst work a fast turn only reads the Match list", async () => {
  const l = lane([match("open")]);
  assert.equal(await l.fast.turn({} as Ctx, 1_000_000), 0);
  assert.deepEqual(l.ran, []);
  assert.equal(l.scans(), 1);
});

test("with Block Burst work a fast turn runs the table, Match and history jobs in order", async () => {
  const l = lane([match("active")]);
  assert.equal(await l.fast.turn({} as Ctx, 1_000_000), 3);
  assert.deepEqual(l.ran, ["tables", "match", "history"]);
});

test("after the last Match closes the lane stays hot for the history write, then goes quiet", async () => {
  const matches = [match("active")];
  const l = lane(matches);
  await l.fast.turn({} as Ctx, 1_000_000);
  matches.length = 0;
  l.ran.length = 0;
  assert.equal(await l.fast.turn({} as Ctx, 1_015_000), 3);
  assert.equal(await l.fast.turn({} as Ctx, 1_021_000), 0);
});

test("a Match that has sat in the same stage for five minutes is stuck: the lane stops running for it, until something changes", async () => {
  const stuck = match("settling");
  const matches = [stuck];
  const l = lane(matches);
  assert.equal(await l.fast.turn({} as Ctx, 1_000_000), 3);
  assert.equal(await l.fast.turn({} as Ctx, 1_200_000), 3);
  assert.equal(await l.fast.turn({} as Ctx, 1_400_000), 0, "unchanged for 400 s");
  matches.push(match("active"));
  assert.equal(await l.fast.turn({} as Ctx, 1_404_000), 3, "a new joined Match wakes it");
});

test("a turn that runs the jobs first observes the keeper's balance; an idle one does not", async () => {
  const l = lane([match("active")]);
  await l.fast.turn({} as Ctx, 1_000_000);
  assert.equal(l.observed(), 1);
  const idle = lane([]);
  await idle.fast.turn({} as Ctx, 1_000_000);
  assert.equal(idle.observed(), 0);
});
