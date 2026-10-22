import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { chainOf, ixNameOf, storeBytes } from "./fixtures.ts";
import { OVERFLOW_MATCH, OVERFLOW_SEASON, basketOf, matchOverflowId, overflowAddress, seasonOverflowId, spillOf } from "./kit.ts";
import { OVERFLOW_STORE_AT, claimStep, overflowJob, overflowRowOf, type OverflowDeps } from "./overflow.ts";
import { loadIdl } from "./runtime.ts";
import type { Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;

/** An overflow record: head (payer, kind, id) and a line store of `owner`. */
function recordBytes(o: { payer: PublicKey; kind: number; id: Buffer; owner: PublicKey; lines: { source: PublicKey; amount: bigint }[]; capacity?: number }): Buffer {
  const store = storeBytes(
    o.lines.map((l) => ({ side: 1, cls: 3, tranche: 0, dueAt: 0n, source: l.source, amount: l.amount })),
    { account: o.owner, capacity: o.capacity ?? 4, bodyAt: OVERFLOW_STORE_AT },
  );
  o.payer.toBuffer().copy(store, 8);
  store[40] = o.kind;
  o.id.copy(store, 41);
  return store;
}

describe("overflow record addresses", () => {
  it("split the 40-byte id in two seeds, one Match id or one Season step", () => {
    const [opener, owner] = [k(), k()];
    const id = matchOverflowId({ opener, n: 7n });
    assert.equal(id.length, 40);
    assert.notEqual(overflowAddress(owner, OVERFLOW_MATCH, id).toBase58(), overflowAddress(owner, OVERFLOW_MATCH, matchOverflowId({ opener, n: 8n })).toBase58());
    const season = seasonOverflowId(3, 1, 2);
    assert.deepEqual([...season.subarray(0, 6)], [3, 0, 0, 0, 1, 2]);
    assert.notEqual(overflowAddress(owner, OVERFLOW_SEASON, season).toBase58(), overflowAddress(owner, OVERFLOW_SEASON, seasonOverflowId(3, 1, 1)).toBase58());
  });
});

describe("what to do with a record", () => {
  const [keeper, owner, other] = [k(), k(), k()];
  const row = (payer: PublicKey, lines: number) => overflowRowOf(k(), recordBytes({ payer, kind: OVERFLOW_MATCH, id: Buffer.alloc(40), owner, lines: Array.from({ length: lines }, () => ({ source: k(), amount: 5n })) }));
  it("reads the head and the lines", () => {
    const r = row(other, 2);
    assert.equal(r.payer.toBase58(), other.toBase58());
    assert.equal(r.owner.toBase58(), owner.toBase58());
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].amount, 5n);
  });
  it("claims an empty record or one with room, grows only for a prize the keeper paid, else waits", () => {
    assert.equal(claimStep(row(other, 0), 0, keeper).kind, "claim");
    assert.equal(claimStep(row(other, 2), 1, keeper).kind, "claim");
    assert.equal(claimStep(row(keeper, 1), 0, keeper).kind, "grow");
    assert.equal(claimStep(row(other, 1), 0, keeper).kind, "wait");
  });
});

describe("the overflow job", () => {
  const keeper = Keypair.generate();
  function run(rows: { pubkey: PublicKey; data: Buffer }[], stores: Map<string, Buffer>) {
    const sent: string[] = [];
    const d: OverflowDeps = {
      list: async () => rows,
      read: { async many(keys) { return keys.map((x) => (stores.has(x.toBase58()) ? ({ data: stores.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), "sig"),
    };
    const ctx = { core: chainOf(core, new Map()), conn: { getBalance: async () => 1e9 }, payer: keeper, now: 1, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent };
  }
  const stores = (owner: PublicKey, free: number) => new Map([
    [basketOf(owner).toBase58(), storeBytes([], { account: owner, capacity: free })],
    [spillOf(owner).toBase58(), storeBytes([], { account: owner, capacity: 0 })],
  ]);
  const record = (owner: PublicKey, payer: PublicKey, lines: number) => ({
    pubkey: k(),
    data: recordBytes({ payer, kind: OVERFLOW_MATCH, id: Buffer.alloc(40), owner, lines: Array.from({ length: lines }, () => ({ source: k(), amount: 9n })) }),
  });

  it("claims a record whose owner has room, and leaves one whose owner has none", async () => {
    const [withRoom, full] = [k(), k()];
    const w = run([record(withRoom, k(), 1), record(full, k(), 1)], new Map([...stores(withRoom, 4), ...stores(full, 0)]));
    await overflowJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["claimOverflow"]);
  });
  it("makes room for a prize it paid for, then claims", async () => {
    const owner = k();
    const w = run([record(owner, keeper.publicKey, 1)], stores(owner, 0));
    await overflowJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["growStore", "claimOverflow"]);
  });
  it("closes an empty record (nothing to move) so its rent returns", async () => {
    const owner = k();
    const w = run([record(owner, k(), 0)], stores(owner, 0));
    await overflowJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["claimOverflow"]);
  });
});
