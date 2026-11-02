import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CreditMeter, creditsOf, meteredFetch, scanProgramAccounts, type ScanRpc } from "./credits.ts";

const rpcBody = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
const ok = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: null }), { status: 200 });
const post = (f: typeof fetch, body: string) => f("https://x.invalid", { method: "POST", body });

describe("credit meter", () => {
  it("weighs getProgramAccounts at 10 credits and everything else at 1", () => {
    assert.equal(creditsOf("getProgramAccounts"), 10);
    assert.equal(creditsOf("getBalance"), 1);
    assert.equal(creditsOf("getProgramAccountsV2"), 1);
  });

  it("totals calls and credits by method, including batched requests", async () => {
    const meter = new CreditMeter();
    const f = meteredFetch(ok as typeof fetch, meter, { mainnet: () => false });
    await post(f, rpcBody("getBalance"));
    await post(f, rpcBody("getBalance"));
    await post(f, rpcBody("getProgramAccounts"));
    await post(f, JSON.stringify([JSON.parse(rpcBody("getSlot")), JSON.parse(rpcBody("getBlockTime"))]));
    assert.deepEqual(meter.byMethod(), { getBalance: { calls: 2, credits: 2 }, getProgramAccounts: { calls: 1, credits: 10 }, getSlot: { calls: 1, credits: 1 }, getBlockTime: { calls: 1, credits: 1 } });
    assert.equal(meter.totalCredits(), 14);
  });

  it("attributes calls to the job running them, and the rest to the pass", async () => {
    const meter = new CreditMeter();
    const f = meteredFetch(ok as typeof fetch, meter, { mainnet: () => false });
    await post(f, rpcBody("getSlot"));
    await Promise.all([
      meter.inJob("match", () => post(f, rpcBody("getProgramAccounts"))),
      meter.inJob("price", async () => {
        await new Promise((r) => setTimeout(r, 1));
        await post(f, rpcBody("getBalance"));
      }),
    ]);
    assert.deepEqual(meter.byJob(), { "(pass)": 1, match: 10, price: 1 });
    const lines = meter.report();
    assert.equal(lines[0], "credits match 10");
    assert.equal(lines.at(-1), "credits run total=12 calls=3");
  });

  it("resets after a run", async () => {
    const meter = new CreditMeter();
    const f = meteredFetch(ok as typeof fetch, meter, { mainnet: () => false });
    await post(f, rpcBody("getSlot"));
    meter.reset();
    assert.equal(meter.totalCredits(), 0);
  });

  it("counts a plain getProgramAccounts as an error on mainnet and names the V2 helper", async () => {
    const meter = new CreditMeter();
    let sent = 0;
    const f = meteredFetch((async () => (sent++, ok())) as typeof fetch, meter, { mainnet: () => true });
    await assert.rejects(post(f, rpcBody("getProgramAccounts")), /getProgramAccountsV2/);
    assert.equal(sent, 0);
    await post(f, rpcBody("getProgramAccountsV2"));
    assert.equal(sent, 1);
  });
});

const programId = Keypair.generate().publicKey;
const rowJson = (pk: PublicKey, data: number[]) => ({ pubkey: pk.toBase58(), account: { data: [Buffer.from(data).toString("base64"), "base64"], lamports: 5, owner: programId.toBase58(), executable: false, rentEpoch: 0 } });

describe("getProgramAccountsV2 scan", () => {
  it("pages until the cursor is null and passes the filters on every page", async () => {
    const [a, b, c] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const pages = [
      { accounts: [rowJson(a, [1]), rowJson(b, [2])], paginationKey: "k1" },
      { accounts: [rowJson(c, [3])], paginationKey: null },
    ];
    const seen: any[] = [];
    const rpc: ScanRpc = {
      helius: true,
      call: async (method, params) => {
        seen.push([method, params]);
        return pages[seen.length - 1];
      },
      getProgramAccounts: async () => assert.fail("must not fall back"),
    };
    const rows = await scanProgramAccounts(rpc, programId, { filters: [{ dataSize: 10 }, { memcmp: { offset: 0, bytes: "abc" } }], dataSlice: { offset: 0, length: 4 }, changedSinceSlot: 99, limit: 2 });
    assert.deepEqual(rows.map((r) => r.pubkey.toBase58()), [a, b, c].map((k) => k.toBase58()));
    assert.deepEqual([...rows[2].account.data], [3]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0][0], "getProgramAccountsV2");
    assert.equal(seen[0][1][0], programId.toBase58());
    assert.equal(seen[0][1][1].paginationKey, undefined);
    assert.equal(seen[1][1][1].paginationKey, "k1");
    for (const [, p] of seen) {
      assert.deepEqual(p[1].filters, [{ dataSize: 10 }, { memcmp: { offset: 0, bytes: "abc" } }]);
      assert.deepEqual(p[1].dataSlice, { offset: 0, length: 4 });
      assert.equal(p[1].changedSinceSlot, 99);
      assert.equal(p[1].limit, 2);
      assert.equal(p[1].encoding, "base64");
    }
  });

  it("falls back to plain getProgramAccounts when the RPC is not Helius", async () => {
    const row = { pubkey: Keypair.generate().publicKey, account: { data: Buffer.from([7]), lamports: 1, owner: programId, executable: false } };
    let cfg: unknown;
    const rpc: ScanRpc = {
      helius: false,
      call: async () => assert.fail("no V2 here"),
      getProgramAccounts: async (_p, c) => ((cfg = c), [row]),
    };
    const rows = await scanProgramAccounts(rpc, programId, { filters: [{ dataSize: 10 }], dataSlice: { offset: 0, length: 4 } });
    assert.equal(rows.length, 1);
    assert.deepEqual(cfg, { commitment: "confirmed", filters: [{ dataSize: 10 }], dataSlice: { offset: 0, length: 4 } });
  });
});
