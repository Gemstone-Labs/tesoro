import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Connection, Keypair, type AccountMeta } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { Budget, type Ctx } from "./act.ts";
import { BATCH_OPEN, BATCH_SEALED, PAYOUT_PENDING, bridgeDisc, decodeBatch, vaultWordOf } from "./bridge-ix.ts";
import { batchJob, type BatchDeps } from "./batches.ts";
import { memoryStore, realSteps } from "./season-run.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_SECS, fileHistory, memoryHistory, weeklyBatchRule } from "./admin-batches.ts";
import { accountBytes, batchBytes, bookBytes, chainOf, payoutBytes, routeBytes } from "./fixtures.ts";
import { bookOf, configAddress, economyAddress } from "./kit.ts";
import { BRIDGE } from "./lz.ts";
import { loadIdl } from "./runtime.ts";
import type { Info } from "./supply.ts";

const k = () => Keypair.generate().publicKey;
/** The same address on every read, so a record made by one run names the batch the next run reads. */
const fixed = (n: number) => Keypair.fromSeed(Buffer.alloc(32, n)).publicKey;
const peer = vaultWordOf(Buffer.alloc(20, 7));
const EID = 40449;
const DAY = DAY_SECS * 1000;
const T0 = 1_800_000_000_000;
const batch = (o: Omit<Parameters<typeof batchBytes>[0], "eid" | "peer">) => decodeBatch(k(), batchBytes({ eid: EID, peer, ...o }));

describe("the weekly resend rule: a Sealed batch is sent again only after the vault paid more, at most daily", () => {
  const owed = (paid: bigint, sends = 1) => batch({ id: 1n, state: BATCH_SEALED, kind: 0, count: 2, total: 1000n, paid, sends });

  it("sends a batch never sent, and leaves one sent by an earlier run with no record alone", () => {
    const rule = weeklyBatchRule(memoryHistory());
    assert.equal(rule.canSend(owed(0n, 0), T0), true);
    assert.equal(rule.canSend(owed(0n, 3), T0), false, "it was sent before and nothing says what the vault had paid then");
  });
  it("does not send again while the vault has paid nothing more, however long ago", () => {
    const b = owed(250n);
    const rule = weeklyBatchRule(memoryHistory());
    rule.sent(b, T0);
    assert.equal(rule.canSend(b, T0 + 30 * DAY), false);
  });
  it("sends again once the vault paid more and a day has passed, not before", () => {
    const b = owed(250n);
    const rule = weeklyBatchRule(memoryHistory());
    rule.sent(b, T0);
    const more = { ...b, paidUnits: 400n };
    assert.equal(rule.canSend(more, T0 + DAY - 1), false, "paid more, but sent under a day ago");
    assert.equal(rule.canSend(more, T0 + DAY), true);
  });
  it("remembers the paid amount of the latest send, not the first", () => {
    const b = owed(250n);
    const rule = weeklyBatchRule(memoryHistory());
    rule.sent(b, T0);
    rule.sent({ ...b, paidUnits: 400n }, T0 + 2 * DAY);
    assert.equal(rule.canSend({ ...b, paidUnits: 400n }, T0 + 9 * DAY), false);
    assert.equal(rule.canSend({ ...b, paidUnits: 401n }, T0 + 9 * DAY), true);
  });
  it("covers Platform and Studio only, and leaves prize payouts alone", () => {
    const rule = weeklyBatchRule(memoryHistory());
    assert.deepEqual([...rule.kinds], [0, 1]);
    assert.equal(rule.payouts, false);
  });
});

describe("the batch job under the weekly rule", () => {
  const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
  async function world(rows: { batches: Buffer[]; payouts?: Buffer[]; counters?: [bigint, bigint, bigint] }, dryRun = false) {
    const [source, position] = [k(), k()];
    const accounts = new Map<string, Buffer>();
    accounts.set(configAddress.toBase58(), await accountBytes(core, "Config", { platformRecipient: k(), poolAccount: k() }));
    accounts.set(economyAddress.toBase58(), await accountBytes(core, "EconomyConfig", { tesoroStudio: k() }));
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes() } }));
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 0, 0, 0], rows.counters ?? [0n, 0n, 0n]));
    accounts.set(position.toBase58(), await accountBytes(core, "PositionState", { positionId: [...Buffer.concat([Buffer.alloc(20, 7), Buffer.alloc(12)])], inner: { sourceChain: { ethereum: {} } } }));
    const sent: string[] = [];
    const d: BatchDeps = {
      list: async (name) => (name === "SourceState" ? [{ pubkey: source, data: accounts.get(source.toBase58())! }] : []),
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => (i.programId.equals(BRIDGE) ? Buffer.from(i.data).subarray(0, 8).toString("hex").slice(0, 4) : "x")).join("+")), "sig"),
      simulate: async () => null,
      now: () => Date.now(),
      listBridge: async (disc) =>
        disc.equals(bridgeDisc.route) ? [{ pubkey: k(), data: routeBytes({ eid: EID, peer, min: 100n, lastBatchId: 2n, escrowEnabled: true }) }]
        : disc.equals(bridgeDisc.batch) ? rows.batches.map((data, i) => ({ pubkey: fixed(10 + i), data }))
        : disc.equals(bridgeDisc.payout) ? (rows.payouts ?? []).map((data, i) => ({ pubkey: fixed(50 + i), data })) : [],
      lz: async () => ({ fee: 1000n, send: [{ pubkey: k(), isSigner: false, isWritable: false } satisfies AccountMeta] }),
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer: Keypair.generate(), now: 0, settings: { dryRun, maxLzFeeLamports: 1e9, lzHourlyCapLamports: 1e9 }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent };
  }

  it("seals and sends a Platform batch once, then does not send it again in the next run", async () => {
    const history = memoryHistory();
    const w = await world({ batches: [batchBytes({ eid: EID, peer, id: 5n, kind: 0, state: BATCH_SEALED, count: 2, total: 500n, paid: 100n, sends: 0 })] });
    assert.equal(await batchJob(w.ctx, w.d, weeklyBatchRule(history)), 1);
    assert.equal(w.sent.length, 1);
    const again = await world({ batches: [batchBytes({ eid: EID, peer, id: 5n, kind: 0, state: BATCH_SEALED, count: 2, total: 500n, paid: 100n, sends: 1 })] });
    assert.equal(await batchJob(again.ctx, again.d, weeklyBatchRule(history)), 0, "next run, same payment: nothing to send");
  });
  it("skips the Leaderboard batch and every payout", async () => {
    const w = await world({
      batches: [batchBytes({ eid: EID, peer, id: 6n, kind: 2, state: BATCH_SEALED, count: 1, total: 9n, sends: 0 })],
      payouts: [payoutBytes({ eid: EID, peer, id: 1n, state: PAYOUT_PENDING })],
    });
    assert.equal(await batchJob(w.ctx, w.d, weeklyBatchRule(memoryHistory())), 0);
    assert.deepEqual(w.sent, []);
  });
  it("seals an Open Studio batch that reached the minimum; a dry run sends nothing and records nothing", async () => {
    const history = memoryHistory();
    const w = await world({ batches: [batchBytes({ eid: EID, peer, id: 7n, kind: 1, state: BATCH_OPEN, count: 1, total: 300n }), batchBytes({ eid: EID, peer, id: 8n, kind: 0, state: BATCH_SEALED, count: 1, total: 300n, sends: 0 })] }, true);
    assert.equal(await batchJob(w.ctx, w.d, weeklyBatchRule(history)), 2, "seal and send are planned");
    assert.deepEqual(w.sent, []);
    assert.deepEqual(history.all(), {}, "the dry run left no record, so the real run still sends");
  });

  it("the Season run's batches step: two hourly retries, each a fresh process on the same record, send an owed batch and a pending payout once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "admin-batches-")), "admin-batches.json");
    const step = (w: Awaited<ReturnType<typeof world>>) => realSteps(w.ctx, memoryStore(), {} as never, { history: fileHistory(file), batchDeps: w.d }).batches();
    const rows = (sends: number) => ({
      batches: [batchBytes({ eid: EID, peer, id: 5n, kind: 0, state: BATCH_SEALED, count: 2, total: 500n, paid: 100n, sends }), batchBytes({ eid: EID, peer, id: 6n, kind: 2, state: BATCH_SEALED, count: 1, total: 50n, paid: 0n, sends })],
      payouts: [payoutBytes({ eid: EID, peer, id: 30n, state: PAYOUT_PENDING })],
    });
    const first = await world(rows(0));
    await step(first);
    assert.equal(first.sent.length, 3, "the Platform batch, the Leaderboard batch and the payout");
    const retry = await world(rows(1));
    await step(retry);
    assert.deepEqual(retry.sent, [], "an hour later nothing is sent again");
  });
});
