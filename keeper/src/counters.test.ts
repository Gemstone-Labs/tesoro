import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { cashInJob, counterAmounts, createAtaIdempotentIx, harvestJob, nextSlice, type CounterDeps, type Recipients } from "./counters.ts";
import { accountBytes, bookBytes, chainOf, ixNameOf } from "./fixtures.ts";
import { bookOf, pda } from "./kit.ts";
import { ata } from "./kind-pay.ts";
import { loadIdl } from "./runtime.ts";
import { SIM_SOL_MINT, type Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;

describe("counters", () => {
  it("reads the three fee counters of a book", () => {
    assert.deepEqual(counterAmounts(bookBytes([0, 0, 0, 0], [5n, 6n, 7n])), [5n, 6n, 7n]);
  });
  it("walks a list by key, wrapping, and keeps its place when items come and go", () => {
    assert.deepEqual(nextSlice(["a", "b", "c", "d", "e"], null, 2), { slice: ["a", "b"], next: "b" });
    assert.deepEqual(nextSlice(["a", "b", "c", "d", "e"], "d", 3), { slice: ["e", "a", "b"], next: "b" });
    assert.deepEqual(nextSlice(["a", "b"], null, 9), { slice: ["a", "b"], next: "b" });
    assert.deepEqual(nextSlice([], "c", 2), { slice: [], next: null });
    // a Source before the cursor closes: the walk continues with the same next Source
    assert.deepEqual(nextSlice(["b", "c", "d", "e"], "b", 2), { slice: ["c", "d"], next: "d" });
    // the cursor's own Source closed: it continues with the next key
    assert.deepEqual(nextSlice(["a", "c", "e"], "b", 2), { slice: ["c", "e"], next: "e" });
  });
  it("creates an associated token account idempotently", () => {
    const [payer, owner, mint] = [k(), k(), k()];
    const ix = createAtaIdempotentIx(payer, owner, mint);
    assert.equal(ix.keys[1].pubkey.toBase58(), ata(owner, mint).toBase58());
    assert.equal(ix.data[0], 1);
  });
});

describe("harvest and fee cash-in jobs", () => {
  const payer = Keypair.generate();

  async function world(counters: [bigint, bigint, bigint], opts: { escrow?: boolean } = {}) {
    const [source, position] = [k(), k()];
    const accounts = new Map<string, Buffer>();
    const pool = k();
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes() } }));
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 0, 0, 0], counters));
    accounts.set(position.toBase58(), await accountBytes(core, "PositionState", { inner: { sourceChain: { solana: {} }, sourceAsset: SIM_SOL_MINT.toBytes() } }));
    accounts.set(pda("native").toBase58(), await accountBytes(core, "NativeCustody", { pool, vault: k(), mint: SIM_SOL_MINT, route: { escrowEnabled: opts.escrow ?? true } }));
    const sent: string[] = [];
    const sims: string[] = [];
    let simError: string | null = null;
    const d: CounterDeps = {
      list: async () => [...accounts].filter(([a]) => a === source.toBase58()).map(([a, data]) => ({ pubkey: new PublicKey(a), data })),
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), "sig"),
      simulate: async (ixs) => (sims.push(ixs.map((i) => ixNameOf(core, i)).join("+")), simError),
      now: () => Date.now(),
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: 0, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent, sims, failWith: (e: string | null) => (simError = e) };
  }

  it("harvests a Leaderboard counter into the prize escrow of a route that has it on", async () => {
    const w = await world([0n, 0n, 500n]);
    assert.equal(await harvestJob(w.ctx, w.d), 1);
    assert.deepEqual([w.sims, w.sent], [["harvest"], ["harvest"]]);
  });

  it("leaves Sources of a route whose escrow is off, small counters, and counters with nothing ready", async () => {
    const off = await world([0n, 0n, 500n], { escrow: false });
    await harvestJob(off.ctx, off.d);
    assert.deepEqual(off.sent, []);
    const small = await world([0n, 0n, 3n]);
    await harvestJob(small.ctx, small.d);
    assert.deepEqual(small.sims, []);
    const empty = await world([0n, 0n, 500n]);
    empty.failWith("ZeroAmount");
    await harvestJob(empty.ctx, empty.d);
    assert.deepEqual([empty.sims.length, empty.sent], [1, []], "a failed dry run sends nothing");
    await harvestJob(empty.ctx, empty.d);
    assert.equal(empty.sims.length, 1, "and is not tried again at once");
  });

  it("scans the Sources once per pass, whichever counter jobs run", async () => {
    const w = await world([100n, 40n, 500n]);
    let scans = 0;
    const list = w.d.list;
    w.d.list = async (...args) => (scans++, list(...args));
    await harvestJob(w.ctx, w.d);
    await cashInJob(w.ctx, w.d, async () => ({ platform: { account: k(), wallet: k() }, studio: null }));
    assert.equal(scans, 1);
  });

  const recipients = (): Recipients => ({ platform: { account: k(), wallet: k() }, studio: { account: k(), wallet: k() } });

  it("cashes Platform and Studio counters in, creating the recipient's token account first", async () => {
    const w = await world([100n, 40n, 0n]);
    assert.equal(await cashInJob(w.ctx, w.d, async () => recipients()), 2);
    assert.deepEqual(w.sent, ["?+cashInFee", "?+cashInFee"], "the associated account is made in the same transaction (ATA program instruction)");
  });

  it("does nothing without recipients or counters", async () => {
    const w = await world([100n, 40n, 0n]);
    await cashInJob(w.ctx, w.d, async () => ({ platform: null, studio: null }));
    const none = await world([0n, 0n, 9n]);
    await cashInJob(none.ctx, none.d, async () => recipients());
    assert.deepEqual([w.sent, none.sent], [[], []]);
  });
});
