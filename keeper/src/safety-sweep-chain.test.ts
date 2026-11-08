import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { Raced } from "./act.ts";
import { dbMatches, markGone, readHeadsByAddress, untabledOrRaced, waitingOf } from "./safety-sweep-chain.ts";
import { SLICE_LEN } from "./safety-sweep.ts";

const fixture = Buffer.from((JSON.parse(readFileSync(new URL("../fixtures/core-layouts.json", import.meta.url), "utf8")) as Record<string, string>).match, "hex");
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));

describe("reading Match heads by address", () => {
  it("batches 100 addresses a call, slices the data, and calls a missing or non-Match account gone", async () => {
    const addresses = Array.from({ length: 205 }, (_, i) => new PublicKey(Buffer.concat([Buffer.alloc(31), Buffer.from([i + 1])])));
    const calls: { n: number; config: any }[] = [];
    const rpc = {
      call: async (method: string, params: any[]) => {
        assert.equal(method, "getMultipleAccounts");
        calls.push({ n: params[0].length, config: params[1] });
        return { value: params[0].map((k: string) => (k === addresses[0].toBase58() ? { data: [fixture.subarray(0, SLICE_LEN).toString("base64"), "base64"] } : k === addresses[1].toBase58() ? { data: [Buffer.alloc(SLICE_LEN, 1).toString("base64"), "base64"] } : null)) };
      },
    };
    const { heads, gone } = await readHeadsByAddress(rpc, addresses);
    assert.deepEqual(calls.map((c) => c.n), [100, 100, 5]);
    assert.deepEqual(calls[0].config.dataSlice, { offset: 0, length: SLICE_LEN });
    assert.deepEqual(heads.map((h) => h.address.toBase58()), [addresses[0].toBase58()]);
    assert.equal(gone.length, 204);
  });
});

describe("reading a car's head by address", () => {
  // The worked example's car as Railcar's LiteSVM left it before its first chunk (Settling).
  const car = Buffer.from((JSON.parse(readFileSync(new URL("../../app/src/lib/chain/many-seat-ahead.worked-example.fixtures.json", import.meta.url), "utf8")) as { cases: { match: string }[] }).cases[0].match, "hex");

  it("keeps a car the sweep tracks instead of telling the database it is gone", async () => {
    const rpc = { call: async (_m: string, params: any[]) => ({ value: params[0].map(() => ({ data: [car.subarray(0, SLICE_LEN).toString("base64"), "base64"] })) }) };
    const { heads, gone } = await readHeadsByAddress(rpc, [key(9)]);
    assert.equal(gone.length, 0);
    assert.deepEqual([heads[0].stage, heads[0].car?.seated, heads[0].car?.minSeats], ["settling", 5, 5]);
    assert.ok(heads[0].car!.departedAt > 0 && heads[0].car!.refundAfter === heads[0].car!.departedAt + 86_400);
  });
});

describe("the database side", () => {
  it("lists candidates and reports gone accounts through the two functions of migration 0024", async () => {
    const seen: [string, unknown][] = [];
    const db = async (fn: string, args: Record<string, unknown>) => {
      seen.push([fn, args]);
      return fn === "open_match_sweep_candidates" ? [key(1).toBase58()] : null;
    };
    assert.deepEqual((await dbMatches(db)).map((k) => k.toBase58()), [key(1).toBase58()]);
    await markGone(db, [key(2)]);
    await markGone(db, []);
    assert.deepEqual(seen, [["open_match_sweep_candidates", {}], ["open_match_account_gone", { p_match_states: [key(2).toBase58()] }]]);
  });

  it("refuses a reply that is not a list, so the sweep falls back to the chain", async () => {
    await assert.rejects(dbMatches(async () => null));
  });
});

describe("why an Active Match with no result waits", () => {
  const T = 1_800_000_000;
  it("is untabled once its Game's table wait after the join is over, with no Assignment (ticket 58)", () => {
    // Joined at T: the deadline is the join plus an hour.
    assert.equal(waitingOf(null, T + 3600, T + 299), null);
    assert.equal(waitingOf(null, T + 3600, T + 300), "untabled");
  });
  it("is unbegun once its Assignment's start window closed (ticket 59)", () => {
    assert.equal(waitingOf({ startDeadline: T + 60 }, T + 86_400, T + 60), null);
    assert.equal(waitingOf({ startDeadline: T + 60 }, T + 86_400, T + 61), "unbegun");
  });
});

describe("the sweep's refund_untabled", () => {
  const signer = { publicKey: key(5) };
  it("sends it with the keeper's key", async () => {
    const sent: unknown[] = [];
    const chain = { refundUntabled: async (...a: unknown[]) => (sent.push(a), "sig") };
    assert.equal(await untabledOrRaced(chain, signer, key(1), async () => true), "sig");
    assert.deepEqual(sent, [[signer, key(1)]]);
  });
  it("calls a refusal for a Match that is no longer Active a lost race", async () => {
    const chain = { refundUntabled: async () => Promise.reject(new Error("NotUntabled")) };
    await assert.rejects(untabledOrRaced(chain, signer, key(1), async () => false), Raced);
    await assert.rejects(untabledOrRaced(chain, signer, key(1), async () => true), /NotUntabled/);
  });
});
