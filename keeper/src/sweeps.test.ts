import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { clearRaised, raisedConditions } from "./alerts.ts";
import { accountBytes, chainOf, ixNameOf } from "./fixtures.ts";
import { programDataOf } from "./kit.ts";
import { loadIdl } from "./runtime.ts";
import { PAIR_WINDOW_SECS, RECEIPT_KEEP_SECS } from "./reclaim.ts";
import { deploySlotOf, listingJob, listingOutcome, listingStep, sweepJob, type SweepDeps } from "./sweeps.ts";
import type { Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const NOW = 1_800_000_000;

describe("listing upkeep rules", () => {
  const g = { game: k(), record: k(), listedUntil: NOW + 100, approvedSlot: 50n };
  it("a program deployed again since approval needs a refresh; an unlisted or current one needs nothing", () => {
    assert.deepEqual(listingStep(g, 50n, NOW), { kind: "current" });
    assert.deepEqual(listingStep(g, 51n, NOW), { kind: "refresh" });
    assert.equal(listingStep({ ...g, listedUntil: NOW - 1 }, 51n, NOW), null);
  });
  it("reads the deploy slot from a ProgramData account", () => {
    const b = Buffer.alloc(45);
    b.writeUInt32LE(3, 0);
    b.writeBigUInt64LE(777n, 4);
    assert.equal(deploySlotOf(b), 777n);
  });
  it("tells a changed Game from a harmless race", () => {
    assert.equal(listingOutcome(null), "ok");
    assert.equal(listingOutcome('{"InstructionError":[0,{"Custom":6500}]} Program log: AnchorError ... Error Code: CodeChanged.'), "changed");
    assert.equal(listingOutcome("... Error Code: ListingCurrent."), "harmless");
    assert.equal(listingOutcome("... Error Code: NotListed."), "harmless");
    assert.equal(listingOutcome("boom"), "other");
  });
});

describe("the sweep and listing jobs", () => {
  const payer = Keypair.generate();
  function run(accounts: Map<string, Buffer>, lists: Record<string, { pubkey: PublicKey; data: Buffer }[]>, simulateWith: string | null = null) {
    const sent: string[] = [];
    const d: SweepDeps = {
      list: async (name) => lists[name] ?? [],
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), "sig"),
      simulate: async () => simulateWith,
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: NOW, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent };
  }

  it("closes old receipts in groups and expired pair records found by a scan alone", async () => {
    const receipt = async (at: number) => ({ pubkey: k(), data: await accountBytes(core, "SettlementReceipt", { matchKey: k(), payer: k(), receipt: { at: new anchor.BN(at) } }) });
    const pair = async (windowStart: number) => ({ pubkey: k(), data: await accountBytes(core, "PairState", { payer: k(), windowStart: new anchor.BN(windowStart), opener: k(), joiner: k() }) });
    const w = run(new Map(), {
      SettlementReceipt: [await receipt(NOW - RECEIPT_KEEP_SECS - 1), await receipt(NOW - 10), await receipt(NOW - RECEIPT_KEEP_SECS - 5)],
      PairState: [await pair(NOW - PAIR_WINDOW_SECS - 1), await pair(NOW - 10), await pair(NOW - PAIR_WINDOW_SECS - 9)],
    });
    await sweepJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["closeReceipt+closeReceipt", "closePair+closePair"]);
  });

  const gameRecord = async (game: PublicKey, over: object = {}) => ({ pubkey: k(), data: await accountBytes(core, "GameRecord", { game, listedUntil: new anchor.BN(NOW + 1000), approvedSlot: new anchor.BN(50), ...over }) });
  const programData = (game: PublicKey, slot: bigint) => {
    const b = Buffer.alloc(45);
    b.writeUInt32LE(3, 0);
    b.writeBigUInt64LE(slot, 4);
    return new Map([[programDataOf(game).toBase58(), b]]);
  };

  it("refreshes a listing whose program was only extended", async () => {
    const game = k();
    const w = run(programData(game, 60n), { GameRecord: [await gameRecord(game)] });
    await listingJob(w.ctx, w.d);
    assert.deepEqual(w.sent, ["refreshListing"]);
  });

  it("does nothing when the slot is the approved one, and alerts (once, until cleared) when the code changed", async () => {
    const game = k();
    const current = run(programData(game, 50n), { GameRecord: [await gameRecord(game)] });
    await listingJob(current.ctx, current.d);
    assert.deepEqual(current.sent, []);
    const changed = run(programData(game, 60n), { GameRecord: [await gameRecord(game)] }, "Error Code: CodeChanged.");
    await listingJob(changed.ctx, changed.d);
    assert.deepEqual(changed.sent, []);
    assert.equal(raisedConditions().filter((c) => c.key === `listing:${game.toBase58()}`).length, 1);
    clearRaised(`listing:${game.toBase58()}`);
  });
});
