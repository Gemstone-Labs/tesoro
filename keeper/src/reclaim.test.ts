import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { PAIR_HEAD_BYTES, PAIR_RECORD_LEN, PAIR_WINDOW_SECS, RECEIPT_KEEP_SECS, groupsOf, oldReceipts, pairRowOf, pairsToClose } from "./reclaim.ts";
import { sweepJob, type SweepDeps } from "./sweeps.ts";
import { janitor, type JanitorDeps } from "./janitor.ts";

const k = () => Keypair.generate().publicKey;
const NOW = 1_800_000_000;

describe("old receipts and pair records", () => {
  it("lists receipts older than 14 days and pairs whose window ended", () => {
    const r = (at: number) => ({ address: k(), payer: k(), at });
    const [old, fresh] = [r(NOW - RECEIPT_KEEP_SECS), r(NOW - RECEIPT_KEEP_SECS + 1)];
    assert.deepEqual(oldReceipts([old, fresh], NOW), [old]);
    const p = (windowStart: number) => ({ address: k(), payer: k(), windowStart });
    const [ended, open] = [p(NOW - PAIR_WINDOW_SECS), p(NOW - 5)];
    assert.deepEqual(pairsToClose([ended, open], NOW), [ended]);
    assert.deepEqual(groupsOf([1, 2, 3], 2), [[1, 2], [3]]);
  });

  it("reads a pair row from a full record or from its sliced head alike", () => {
    const payer = k();
    const full = Buffer.alloc(PAIR_RECORD_LEN);
    payer.toBuffer().copy(full, 9);
    full.writeBigInt64LE(1234n, 41);
    const address = k();
    const expected = { address, payer, windowStart: 1234 };
    assert.deepEqual(pairRowOf({ pubkey: address, data: full }), expected);
    assert.deepEqual(pairRowOf({ pubkey: address, data: full.subarray(0, PAIR_HEAD_BYTES) }), expected);
  });
});

describe("one copy of the receipt and pair sweeps", () => {
  it("the sweep job and the janitor list the same pair records the same way", async () => {
    const seen: unknown[] = [];
    const list: SweepDeps["list"] = async (name, opts) => (seen.push([name, opts?.dataSize, opts?.dataSlice]), []);
    const base = { list, read: { many: async () => [] }, send: async () => "sig", simulate: async () => null } as unknown as SweepDeps;
    const ctx = { now: NOW, settings: { dryRun: false }, core: {} } as never;
    await sweepJob(ctx, base);
    const sweep = seen.filter((s) => (s as unknown[])[0] === "PairState");
    seen.length = 0;
    await janitor(ctx, { ...base, assignments: [], deploySlots: async () => [], publishApy: null } as unknown as JanitorDeps, ["pairs"]);
    assert.deepEqual(seen.filter((s) => (s as unknown[])[0] === "PairState"), sweep);
  });
});
