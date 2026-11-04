import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { dbMatches, markGone, readHeadsByAddress } from "./safety-sweep-chain.ts";
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
