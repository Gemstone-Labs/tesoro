import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, bookBytes, chainOf, ixNameOf } from "./fixtures.ts";
import { bookOf, economyAddress, pda } from "./kit.ts";
import { fillSizes, orderJob, orderOf, planExpiry, planFills, type FillRule, type OrderDeps, type OrderRow } from "./orders.ts";
import { loadIdl } from "./runtime.ts";
import { SIM_SOL_MINT, type Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const NOW = 1_800_000_000;

const lineBytes = (source: PublicKey, amount: bigint) => {
  const b = Buffer.alloc(144);
  source.toBuffer().copy(b, 11);
  b.writeBigUInt64LE(amount, 43);
  return [...b];
};
const orderState = (over: { source: PublicKey; amount: bigint; createdAt?: number; expiresAt?: number; account?: PublicKey; payer?: PublicKey; owner?: PublicKey }) =>
  accountBytes(core, "InstantOrderState", {
    account: over.account ?? k(),
    owner: over.owner ?? k(),
    payer: over.payer ?? k(),
    line: lineBytes(over.source, over.amount),
    createdAt: new anchor.BN(over.createdAt ?? NOW - 100),
    expiresAt: new anchor.BN(over.expiresAt ?? NOW + 1000),
  });
const row = (over: Partial<OrderRow> = {}): OrderRow => ({ address: k(), account: k(), payer: k(), owner: k(), source: k(), open: 100n, createdAt: NOW - 100, expiresAt: NOW + 1000, ...over });

describe("reading an order", () => {
  it("takes the Source and the open Gemas from the order's line", async () => {
    const source = k();
    const address = k();
    const r = orderOf(address, core.coder.accounts.decode("instantOrderState", await orderState({ source, amount: 321n, createdAt: 7, expiresAt: 99 })));
    assert.deepEqual([r.source.toBase58(), r.open, r.createdAt, r.expiresAt], [source.toBase58(), 321n, 7, 99]);
  });
});

describe("expiry", () => {
  it("lists orders past their expiry", () => {
    const [a, b] = [row({ expiresAt: NOW - 1 }), row({ expiresAt: NOW + 5 })];
    assert.deepEqual(planExpiry([a, b], NOW), [a]);
  });
});

describe("the fill rule", () => {
  const rule: FillRule = { maxGemasPerPass: 250n, ordersPerPass: 3 };
  const filler = k();
  const on = { keeperFills: true, fillKeeper: filler };
  const holds = (key: PublicKey) => key.equals(filler);

  it("is off unless the chain says so, this process holds the fill key and it has a budget", () => {
    const rows = [row()];
    assert.deepEqual(planFills(rows, NOW, rule, { ...on, keeperFills: false }, holds), []);
    assert.deepEqual(planFills(rows, NOW, rule, { ...on, fillKeeper: k() }, holds), []);
    assert.deepEqual(planFills(rows, NOW, { ...rule, maxGemasPerPass: 0n }, on, holds), []);
    assert.equal(planFills(rows, NOW, rule, on, holds).length, 1);
  });
  it("fills the oldest orders first inside the pass budget and skips expired and empty ones", () => {
    const [old, mid, young, gone, empty] = [row({ createdAt: 1, open: 200n }), row({ createdAt: 2, open: 200n }), row({ createdAt: 3 }), row({ createdAt: 0, expiresAt: NOW - 1 }), row({ createdAt: 0, open: 0n })];
    const plan = planFills([young, mid, gone, old, empty], NOW, rule, on, holds);
    assert.deepEqual(plan.map((p) => [p.row, p.gemas]), [[old, 200n], [mid, 50n]]);
  });
  it("tries smaller fills when the whole amount would fail", () => {
    assert.deepEqual(fillSizes(100n), [100n, 50n, 25n, 12n]);
    assert.deepEqual(fillSizes(1n), [1n]);
  });
});

describe("the order job", () => {
  const payer = Keypair.generate();
  const source = k();
  const position = k();

  async function world(orders: { address: PublicKey; data: Buffer }[], over: { keeperFills?: boolean; fillKeeper?: PublicKey } = {}) {
    const accounts = new Map<string, Buffer>();
    accounts.set(economyAddress.toBase58(), await accountBytes(core, "EconomyConfig", { keeperFills: over.keeperFills ?? false, fillKeeper: over.fillKeeper ?? PublicKey.default }));
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 0, 0, 0]));
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes() } }));
    accounts.set(position.toBase58(), await accountBytes(core, "PositionState", { inner: { sourceChain: { solana: {} }, sourceAsset: SIM_SOL_MINT.toBytes() } }));
    accounts.set(pda("native").toBase58(), await accountBytes(core, "NativeCustody", { pool: k(), vault: k(), mint: SIM_SOL_MINT }));
    accounts.set(pda("treasury").toBase58(), await accountBytes(core, "Treasury", { vault: k() }));
    const sent: string[] = [];
    const sims: number[] = [];
    const d: OrderDeps = {
      list: async () => orders.map((o) => ({ pubkey: o.address, data: o.data })),
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), "sig"),
      simulate: async () => (sims.push(1), sims.length < 2 ? "InsufficientTreasury" : null),
      rule: { maxGemasPerPass: 1000n, ordersPerPass: 3 },
      candidates: () => [payer],
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: NOW, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent, sims };
  }

  it("ends an expired order and leaves a live one", async () => {
    const [a, b] = [k(), k()];
    const w = await world([
      { address: a, data: await orderState({ source, amount: 40n, expiresAt: NOW - 5 }) },
      { address: b, data: await orderState({ source, amount: 40n, expiresAt: NOW + 5 }) },
    ]);
    await orderJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["expireInstantRedeem"]);
  });

  it("fills nothing while the chain switch is off", async () => {
    const w = await world([{ address: k(), data: await orderState({ source, amount: 40n }) }], { keeperFills: false });
    await orderJob(w.ctx, w.d);
    assert.deepEqual(w.sent, []);
    assert.equal(w.sims.length, 0);
  });

  it("fills with the largest size a dry run accepts when the chain switch is on and this keeper is the filler", async () => {
    const w = await world([{ address: k(), data: await orderState({ source, amount: 40n }) }], { keeperFills: true, fillKeeper: payer.publicKey });
    await orderJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["fillInstantRedeem"]);
    assert.equal(w.sims.length, 2, "the first size failed in the dry run, the half passed");
  });
});
