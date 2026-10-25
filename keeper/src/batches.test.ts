import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type AccountMeta } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { BATCH_DONE, BATCH_OPEN, BATCH_SEALED, PAYOUT_PAID, PAYOUT_PENDING, PAYOUT_REFUNDED, PAYOUT_REJECTED, bridgeDisc, decodeBatch, decodePayout, decodeRoute, addToBatchIx, batchPda, openBatchIx, redeemTreasuryToEvmIx, vaultPositionId, vaultWordOf } from "./bridge-ix.ts";
import { evmRoutesToFund, fundEvmPrizes, kindsOf, planBatches, planPayouts, routeKey, routeOf, batchJob, type BatchDeps, type EvmPrizeDeps } from "./batches.ts";
import { accountBytes, batchBytes, bookBytes, chainOf, payoutBytes, routeBytes } from "./fixtures.ts";
import { bookOf, configAddress, economyAddress } from "./kit.ts";
import { BRIDGE } from "./lz.ts";
import { loadIdl } from "./runtime.ts";
import type { Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const vault = Buffer.alloc(20, 7);
const peer = vaultWordOf(vault);
const EID = 40449;

describe("bridge accounts", () => {
  it("decodes a route, a batch and a payout from the bridge's byte layout", () => {
    const addr = k();
    const route = decodeRoute(addr, routeBytes({ eid: EID, peer, escrowEnabled: true, min: 50n, lastBatchId: 9n, escrowShares: 100n << 70n, escrowUnits: 5n, issuedShares: 3n, lastFundedSeason: 4 }));
    assert.deepEqual([route.eid, route.escrowEnabled, route.minBatchUnits, route.lastBatchId, route.escrowShares, route.lastFundedSeason], [EID, true, 50n, 9n, 100n << 70n, 4]);
    assert.ok(route.peerAddress.equals(peer));
    const payer = k();
    const batch = decodeBatch(addr, batchBytes({ eid: EID, peer, id: 12n, rentPayer: payer, kind: 1, state: BATCH_SEALED, count: 3, total: 1000n, paid: 250n, sends: 2 }));
    assert.deepEqual([batch.id, batch.kind, batch.state, batch.count, batch.totalUnits, batch.paidUnits, batch.sends, batch.rentPayer.toBase58()], [12n, 1, BATCH_SEALED, 3, 1000n, 250n, 2, payer.toBase58()]);
    const [holder, prize] = [k(), k()];
    const payout = decodePayout(addr, payoutBytes({ eid: EID, peer, id: 3n, state: PAYOUT_REJECTED, holder, prizeSource: prize, gemas: 77n, shares: 99n }));
    assert.deepEqual([payout.id, payout.state, payout.gemas, payout.shares, payout.holderAccount.toBase58(), payout.prizeSource.toBase58()], [3n, PAYOUT_REJECTED, 77n, 99n, holder.toBase58(), prize.toBase58()]);
  });
  it("has the sizes the Rust accounts have (8 + InitSpace)", () => {
    assert.deepEqual([routeBytes({ eid: 1, peer }).length, batchBytes({ eid: 1, peer, id: 1n }).length, payoutBytes({ eid: 1, peer, id: 1n }).length], [202, 656, 230]);
  });
  it("the vault word and the stand-in Position id agree", () => {
    assert.ok(Buffer.from(vaultPositionId(peer).subarray(0, 20)).equals(vault));
    assert.ok(vaultWordOf(vault).equals(peer));
  });
  it("builds every instruction with the accounts the program lists", () => {
    const route = decodeRoute(k(), routeBytes({ eid: EID, peer, lastBatchId: 4n }));
    const open = openBatchIx({ payer: k(), route, kind: 1 });
    assert.equal(open.keys.length, 6);
    assert.ok(open.keys.some((m) => m.pubkey.equals(batchPda(EID, peer, 5n))), "the next batch id");
    const batch = decodeBatch(k(), batchBytes({ eid: EID, peer, id: 5n }));
    const add = addToBatchIx({ batch, chain: "ethereum", recipientAccount: k(), position: k(), source: k(), remaining: [] });
    assert.equal(add.keys.length, 10);
    assert.ok(add.keys.some((m) => m.pubkey.equals(configAddress)) && add.keys.some((m) => m.pubkey.equals(economyAddress)));
    const redeem = redeemTreasuryToEvmIx({ payer: k(), chain: "hyperEvm", treasury: k(), treasuryAccount: k(), treasuryBasket: k(), treasurySpill: k(), position: k(), source: k(), line: { side: 1, dueAt: 5n, cls: 3, tranche: 0 }, gemas: 10n, remaining: [] });
    assert.equal(redeem.keys.length, 13);
    assert.equal(redeem.data.length, 8 + 1 + 8 + 2 + 8);
    assert.equal(redeem.programId.toBase58(), BRIDGE.toBase58());
  });
});

describe("batch plan", () => {
  const route = decodeRoute(k(), routeBytes({ eid: EID, peer, min: 100n }));
  const routes = new Map([[routeKey(EID, peer), route]]);
  const b = (o: Omit<Parameters<typeof batchBytes>[0], "eid" | "peer">) => decodeBatch(k(), batchBytes({ eid: EID, peer, ...o }));

  it("closes Done batches, seals Open ones that reached the minimum or are full, leaves small ones to grow", () => {
    const done = b({ id: 1n, state: BATCH_DONE, count: 1, total: 5n, paid: 5n });
    const ready = b({ id: 2n, state: BATCH_OPEN, count: 2, total: 120n });
    const full = b({ id: 3n, state: BATCH_OPEN, count: 8, total: 10n });
    const small = b({ id: 4n, state: BATCH_OPEN, count: 1, total: 10n });
    const empty = b({ id: 5n, state: BATCH_OPEN, count: 0 });
    const plan = planBatches([done, ready, full, small, empty], routes, new Map(), 1_000_000, 1000);
    assert.deepEqual(plan.map((s) => [s.kind, s.batch.id]), [["close", 1n], ["seal", 2n], ["seal", 3n]]);
  });

  it("sends a Sealed batch that is still owed, again only after the resend time, never one fully paid", () => {
    const owed = b({ id: 6n, state: BATCH_SEALED, count: 1, total: 100n, paid: 40n });
    const paid = b({ id: 7n, state: BATCH_SEALED, count: 1, total: 100n, paid: 100n });
    assert.deepEqual(planBatches([owed, paid], routes, new Map(), 5000, 1000).map((s) => [s.kind, s.batch.id]), [["send", 6n]]);
    const sentAt = new Map([[owed.address.toBase58(), 4500]]);
    assert.deepEqual(planBatches([owed], routes, sentAt, 5000, 1000), [], "sent 500 ms ago");
    assert.equal(planBatches([owed], routes, sentAt, 5600, 1000).length, 1, "and again once the resend time passed");
  });
});

describe("payout plan", () => {
  const p = (state: number, id: bigint) => decodePayout(k(), payoutBytes({ eid: EID, peer, id, state }));
  it("resends Pending, refunds Rejected, closes Paid and Refunded", () => {
    const plan = planPayouts([p(PAYOUT_PENDING, 1n), p(PAYOUT_REJECTED, 2n), p(PAYOUT_PAID, 3n), p(PAYOUT_REFUNDED, 4n)], new Map(), 5000, 1000);
    assert.deepEqual(plan.map((s) => [s.kind, s.payout.id]), [["send", 1n], ["refund", 2n], ["close", 3n], ["close", 4n]]);
  });
  it("waits between resends of a Pending payout", () => {
    const pending = p(PAYOUT_PENDING, 1n);
    assert.deepEqual(planPayouts([pending], new Map([[pending.address.toBase58(), 4800]]), 5000, 1000), []);
  });
});

describe("routes", () => {
  it("an EVM Source belongs to the route of its vault on its chain", () => {
    const eth = decodeRoute(k(), routeBytes({ eid: EID, peer }));
    const hype = decodeRoute(k(), routeBytes({ eid: 40362, peer }));
    const id = Uint8Array.from(Buffer.concat([vault, Buffer.alloc(12)]));
    assert.equal(routeOf([eth, hype], { chain: "hyperEvm", positionId: id }), hype);
    assert.equal(routeOf([eth], { chain: "hyperEvm", positionId: id }), null);
    assert.equal(routeOf([eth], { chain: "ethereum", positionId: Uint8Array.from(Buffer.alloc(32, 1)) }), null);
  });
  it("the Leaderboard batch exists only with the prize escrow on", () => {
    assert.deepEqual(kindsOf(decodeRoute(k(), routeBytes({ eid: EID, peer }))), [0, 1]);
    assert.deepEqual(kindsOf(decodeRoute(k(), routeBytes({ eid: EID, peer, escrowEnabled: true }))), [0, 1, 2]);
  });
  it("a route's prize is issued once per season and only for confirmed escrow", () => {
    const r = (o: object) => decodeRoute(k(), routeBytes({ eid: EID, peer, escrowEnabled: true, ...o }));
    const ok = r({ escrowShares: 10n, issuedShares: 4n, lastFundedSeason: 2 });
    assert.deepEqual(evmRoutesToFund([ok, r({ escrowShares: 10n, issuedShares: 10n }), r({ escrowShares: 5n, lastFundedSeason: 3 }), r({ escrowEnabled: false, escrowShares: 9n })].map((x) => x).filter(Boolean), 3), [ok]);
  });
});

describe("the batch job", () => {
  const payer = Keypair.generate();
  const mkCtx = (accounts: Map<string, Buffer>, dryRun = false): Ctx => ({ core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: 0, settings: { dryRun, maxLzFeeLamports: 1e9, lzHourlyCapLamports: 1e9 }, budget: new Budget(1e15), lz: new Budget(1e15) }) as unknown as Ctx;

  async function world(over: { batches?: Buffer[]; payouts?: Buffer[]; counters?: [bigint, bigint, bigint]; chain?: object } = {}) {
    const [source, position, platform, studio] = [k(), k(), k(), k()];
    const accounts = new Map<string, Buffer>();
    accounts.set(configAddress.toBase58(), await accountBytes(core, "Config", { platformRecipient: platform, poolAccount: k() }));
    accounts.set(economyAddress.toBase58(), await accountBytes(core, "EconomyConfig", { tesoroStudio: studio }));
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes() } }));
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 0, 0, 0], over.counters ?? [500n, 0n, 0n]));
    accounts.set(position.toBase58(), await accountBytes(core, "PositionState", { positionId: [...Buffer.concat([vault, Buffer.alloc(12)])], inner: { sourceChain: over.chain ?? { ethereum: {} } } }));
    const sent: string[] = [];
    const sims: string[] = [];
    const routeRows = [{ pubkey: k(), data: routeBytes({ eid: EID, peer, min: 100n, lastBatchId: 2n }) }];
    const d: BatchDeps = {
      list: async (name) => (name === "SourceState" ? [{ pubkey: source, data: accounts.get(source.toBase58())! }] : []),
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => (i.programId.equals(BRIDGE) ? Buffer.from(i.data).subarray(0, 8).toString("hex").slice(0, 4) : "x")).join("+")), "sig"),
      simulate: async (ixs) => (sims.push(String(ixs.length)), null),
      now: () => Date.now(),
      listBridge: async (disc) => (disc.equals(bridgeDisc.route) ? routeRows : disc.equals(bridgeDisc.batch) ? (over.batches ?? []).map((data) => ({ pubkey: k(), data })) : disc.equals(bridgeDisc.payout) ? (over.payouts ?? []).map((data) => ({ pubkey: k(), data })) : []),
      lz: async () => ({ fee: 1000n, send: [{ pubkey: k(), isSigner: false, isWritable: false } satisfies AccountMeta] }),
    };
    return { d, ctx: mkCtx(accounts), sent, sims };
  }

  it("opens a batch and adds a Source's covered Platform counter in one transaction", async () => {
    const w = await world();
    assert.equal(await batchJob(w.ctx, w.d), 1);
    assert.deepEqual(w.sims, ["2"], "open_batch + add_to_batch, dry run first");
    assert.equal(w.sent.length, 1);
  });

  it("adds to the batch that is already open instead of opening another", async () => {
    const open = batchBytes({ eid: EID, peer, id: 2n, kind: 0, state: BATCH_OPEN, count: 1, total: 10n });
    const w = await world({ batches: [open] });
    await batchJob(w.ctx, w.d);
    assert.deepEqual(w.sims, ["1"]);
  });

  it("skips a Source whose counter has nothing ready (the dry run fails), and a Solana Position", async () => {
    const w = await world();
    w.d.simulate = async () => "ZeroAmount";
    assert.equal(await batchJob(w.ctx, w.d), 0);
    assert.deepEqual(w.sent, []);
    const sol = await world({ chain: { solana: {} } });
    assert.equal(await batchJob(sol.ctx, sol.d), 0);
    assert.deepEqual(sol.sims, []);
  });

  it("seals, sends and closes batches, and handles payouts", async () => {
    const w = await world({
      counters: [0n, 0n, 0n],
      batches: [
        batchBytes({ eid: EID, peer, id: 10n, state: BATCH_OPEN, count: 2, total: 500n }),
        batchBytes({ eid: EID, peer, id: 11n, state: BATCH_SEALED, count: 2, total: 500n, paid: 100n }),
        batchBytes({ eid: EID, peer, id: 12n, state: BATCH_DONE, count: 1, total: 5n, paid: 5n }),
      ],
      payouts: [payoutBytes({ eid: EID, peer, id: 30n, state: PAYOUT_PENDING }), payoutBytes({ eid: EID, peer, id: 31n, state: PAYOUT_REJECTED }), payoutBytes({ eid: EID, peer, id: 32n, state: PAYOUT_PAID })],
    });
    const n = await batchJob(w.ctx, w.d);
    assert.equal(n, 6);
    assert.equal(w.sent.length, 6, "seal, send, close batch; send, refund, close payout");
  });

  it("does not send a LayerZero message above the fee cap", async () => {
    const w = await world({ counters: [0n, 0n, 0n], batches: [batchBytes({ eid: EID, peer, id: 40n, state: BATCH_SEALED, count: 1, total: 9n })] });
    w.d.lz = async () => ({ fee: 5_000_000_000n, send: [] });
    assert.equal(await batchJob(w.ctx, w.d), 0);
    assert.deepEqual(w.sent, []);
  });
});

describe("EVM prizes", () => {
  it("issues a route's prize priced by Pyth when its OnchainPrice exists, by the oracle otherwise", async () => {
    const authority = Keypair.generate();
    const oracle = Keypair.generate();
    const asset = Buffer.alloc(32, 3);
    const routes = [{ pubkey: k(), data: routeBytes({ eid: EID, peer, asset, escrowEnabled: true, escrowShares: 10n }) }];
    const sent: number[] = [];
    const base: Omit<EvmPrizeDeps, "oracle" | "read"> = { listBridge: async () => routes, send: async (ixs, opts) => (sent.push(opts.signers?.length ?? 0), "sig"), usd: async () => 2500 };
    const noPrice: EvmPrizeDeps = { ...base, read: { async many(keys) { return keys.map(() => null); } }, oracle: () => null };
    const mk = (d: EvmPrizeDeps) => ({ core: chainOf(core, new Map()), conn: {}, payer: Keypair.generate(), settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) }) as unknown as Ctx;
    assert.equal(await fundEvmPrizes(mk(noPrice), noPrice, 3, authority, k()), 0, "no Pyth price and no oracle key: skipped");
    const oracled: EvmPrizeDeps = { ...noPrice, oracle: () => oracle };
    assert.equal(await fundEvmPrizes(mk(oracled), oracled, 3, authority, k()), 1);
    assert.deepEqual(sent, [2], "the Season keeper and the oracle sign");
  });
});
