import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { settledPda } from "../../app/src/lib/chain/basket.ts";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, chainOf, ixNameOf, ticketBytes } from "./fixtures.ts";
import { janitor, PARTS, type AssignmentSource, type JanitorDeps } from "./janitor.ts";
import { loadIdl } from "./runtime.ts";
import type { Info } from "./supply.ts";
import { PAIR_RECORD_LEN, PAIR_WINDOW_SECS, RECEIPT_KEEP_SECS } from "./reclaim.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const NOW = 1_800_000_000;

/** A fake chain: accounts by address, listed by type name, and every send recorded. */
function world(over: { lists?: Record<string, { pubkey: PublicKey; data: Buffer }[]>; accounts?: Map<string, Buffer>; simulateWith?: string | null; assignments?: AssignmentSource[]; apy?: JanitorDeps["publishApy"]; slots?: Map<string, bigint>; dryRun?: boolean } = {}) {
  const accounts = over.accounts ?? new Map<string, Buffer>();
  const lists = over.lists ?? {};
  const sent: string[] = [];
  const slices: Record<string, { offset: number; length: number } | undefined> = {};
  const sizes: Record<string, number | undefined> = {};
  const d: JanitorDeps = {
    list: async (name, opts) => {
      slices[name] = opts?.dataSlice;
      sizes[name] = opts?.dataSize;
      return (lists[name] ?? []).map((r) => (opts?.dataSlice ? { ...r, data: r.data.subarray(opts.dataSlice.offset, opts.dataSlice.offset + opts.dataSlice.length) } : r));
    },
    read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
    send: async (ixs) => (sent.push(ixs.map((i) => ixNameOf(core, i)).join("+")), "sig"),
    simulate: async () => over.simulateWith ?? null,
    offers: async () => [],
    assignments: over.assignments ?? [],
    deploySlots: async (games) => games.map((g) => over.slots?.get(g.toBase58()) ?? null),
    publishApy: over.apy ?? null,
  };
  const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer: Keypair.generate(), now: NOW, settings: { dryRun: !!over.dryRun }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
  return { d, ctx, sent, slices, sizes };
}

const receipt = async (at: number) => ({ pubkey: k(), data: await accountBytes(core, "SettlementReceipt", { matchKey: k(), payer: k(), receipt: { at: new anchor.BN(at) } }) });
const pair = async (windowStart: number) => ({ pubkey: k(), data: await accountBytes(core, "PairState", { payer: k(), windowStart: new anchor.BN(windowStart), opener: k(), joiner: k() }) });

describe("the janitor with nothing due", () => {
  it("runs every part, sends nothing and says why each did nothing", async () => {
    const w = world();
    const r = await janitor(w.ctx, w.d);
    assert.deepEqual(r.parts.map((p) => p.name), [...PARTS]);
    assert.deepEqual(w.sent, []);
    assert.ok(r.parts.every((p) => p.actions === 0 && !p.error && p.note));
    assert.deepEqual(r.alerts, []);
  });
});

describe("expired Entry Tickets", () => {
  it("cancels an expired Ticket, closes a Cancelled one and leaves a running one", async () => {
    const [expired, cancelled, running] = [k(), k(), k()];
    const tickets: [PublicKey, Buffer][] = [
      [expired, ticketBytes({ state: 0, expiresAt: NOW - 10, account: k() })],
      [cancelled, ticketBytes({ state: 3, account: k() })],
      [running, ticketBytes({ state: 0, expiresAt: NOW + 500, account: k() })],
    ];
    const accounts = new Map(tickets.map(([a, b]) => [a.toBase58(), b]));
    const w = world({ lists: { TicketHead: tickets.map(([pubkey, data]) => ({ pubkey, data })) }, accounts });
    const r = await janitor(w.ctx, w.d, ["tickets"]);
    assert.ok(w.sent.includes("closeTicket"));
    assert.ok(w.sent.includes("cancelTicket"));
    assert.ok(r.parts[0].actions >= 2);
    assert.ok(w.slices.TicketHead, "Tickets are read as heads, not whole");
  });
});

describe("receipts", () => {
  it("closes receipts older than 14 days in groups and keeps younger ones", async () => {
    const lists = { SettlementReceipt: [await receipt(NOW - RECEIPT_KEEP_SECS - 1), await receipt(NOW - 10), await receipt(NOW - RECEIPT_KEEP_SECS)] };
    const w = world({ lists });
    const r = await janitor(w.ctx, w.d, ["receipts"]);
    assert.deepEqual(w.sent, ["closeReceipt+closeReceipt"]);
    assert.equal(r.parts[0].actions, 1);
  });
});

describe("pair records", () => {
  it("finds them by scan alone (a head slice, current size only) and closes those whose window ended", async () => {
    const ended = await pair(NOW - PAIR_WINDOW_SECS);
    const endedToo = await pair(NOW - PAIR_WINDOW_SECS - 99);
    const open = await pair(NOW - 5);
    const w = world({ lists: { PairState: [ended, endedToo, open] } });
    const r = await janitor(w.ctx, w.d, ["pairs"]);
    assert.deepEqual(w.sent, ["closePair+closePair"]);
    assert.equal(r.parts[0].actions, 1);
    assert.ok(w.slices.PairState && w.slices.PairState.length < 100, "only the head of each record is read");
    assert.equal(w.sizes.PairState, PAIR_RECORD_LEN, "records from before the upgrade (other size) are not listed");
  });

  it("says so when nothing is due", async () => {
    const w = world({ lists: { PairState: [await pair(NOW - 5)] } });
    assert.match((await janitor(w.ctx, w.d, ["pairs"])).parts[0].note ?? "", /no pair record due/);
    assert.deepEqual(w.sent, []);
  });
});

describe("spent Assignments", () => {
  it("closes an Assignment whose Match has a receipt or is gone, and keeps one whose Match is live", async () => {
    const [settled, gone, live] = [k(), k(), k()];
    const accounts = new Map<string, Buffer>([
      [settled.toBase58(), Buffer.alloc(1)],
      [settledPda(settled).toBase58(), Buffer.alloc(1)],
      [live.toBase58(), Buffer.alloc(1)],
    ]);
    const closed: string[] = [];
    const src: AssignmentSource = { label: "holdem", matches: async () => [settled, gone, live], close: async (m) => (closed.push(m.toBase58()), "sig") };
    const w = world({ accounts, assignments: [src] });
    const r = await janitor(w.ctx, w.d, ["assignments"]);
    assert.deepEqual(closed.sort(), [settled.toBase58(), gone.toBase58()].sort());
    assert.equal(r.parts[0].actions, 2);
  });
});

describe("Listings", () => {
  const gameRecord = async (game: PublicKey) => ({ pubkey: k(), data: await accountBytes(core, "GameRecord", { game, listedUntil: new anchor.BN(NOW + 1000), approvedSlot: new anchor.BN(50) }) });
  const slotOf = (game: PublicKey, slot: bigint) => new Map([[game.toBase58(), slot]]);

  it("refreshes a Listing a stranger's extend broke and raises an alert", async () => {
    const game = k();
    const w = world({ lists: { GameRecord: [await gameRecord(game)] }, slots: slotOf(game, 60n) });
    const r = await janitor(w.ctx, w.d, ["listings"]);
    assert.deepEqual(w.sent, ["refreshListing"]);
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0].title, /refreshed/);
  });

  it("does nothing for a current Listing, and alerts without sending when the code really changed", async () => {
    const game = k();
    const current = world({ lists: { GameRecord: [await gameRecord(game)] }, slots: slotOf(game, 50n) });
    assert.deepEqual((await janitor(current.ctx, current.d, ["listings"])).alerts, []);
    assert.deepEqual(current.sent, []);
    const changed = world({ lists: { GameRecord: [await gameRecord(game)] }, slots: slotOf(game, 60n), simulateWith: "Error Code: CodeChanged." });
    const r = await janitor(changed.ctx, changed.d, ["listings"]);
    assert.deepEqual(changed.sent, []);
    assert.match(r.alerts[0].title, /upgraded/);
  });
});

describe("the trailing APY", () => {
  it("is skipped with a reason while nothing can publish it, and published when something can", async () => {
    const none = await janitor(world().ctx, world().d, ["apy"]);
    assert.match(none.parts[0].note ?? "", /ticket 11/);
    let calls = 0;
    const w = world({ apy: async () => (calls++, "30-day 6.1%") });
    const r = await janitor(w.ctx, w.d, ["apy"]);
    assert.deepEqual([calls, r.parts[0].actions], [1, 1]);
    const dry = world({ apy: async () => (calls++, "x"), dryRun: true });
    await janitor(dry.ctx, dry.d, ["apy"]);
    assert.equal(calls, 1, "a dry run publishes nothing");
  });
});

describe("a failing part", () => {
  it("is reported and the others still run", async () => {
    const w = world({ lists: { SettlementReceipt: [await receipt(NOW - RECEIPT_KEEP_SECS - 1)] } });
    w.d.list = async (name) => {
      if (name === "TicketHead") throw new Error("rpc down");
      return name === "SettlementReceipt" ? [await receipt(NOW - RECEIPT_KEEP_SECS - 1)] : [];
    };
    const r = await janitor(w.ctx, w.d);
    assert.equal(r.parts.find((p) => p.name === "tickets")?.error, "rpc down");
    assert.equal(r.parts.find((p) => p.name === "receipts")?.actions, 1);
  });
});

describe("clean-up for Accounts that are away (Break or Self-Exclusion)", () => {
  const ana = k();
  const ben = k();
  const game = k();
  const protectionsOf = async (account: PublicKey, breakUntil: number, selfExclusionUntil = 0) => ({ pubkey: k(), data: await accountBytes(core, "ProtectionsState", { account, inner: { breakUntil: new anchor.BN(breakUntil), selfExclusionUntil: new anchor.BN(selfExclusionUntil) } }) });
  const requestOf = async (player: PublicKey, status: number) => ({ pubkey: k(), data: await accountBytes(core, "RequestState", { inner: { player: Array.from(player.toBytes()), status: { [["open", "accepted", "cancelled"][status]]: {} } } }) });
  const offerOf = async (backer: PublicKey, status: number) => ({ pubkey: k(), data: await accountBytes(core, "OfferState", { inner: { backer: Array.from(backer.toBytes()), request: Array.from(k().toBytes()), status: { [["open", "accepted", "consumed", "cancelled", "expired"][status]]: {} } } }) });
  const matchOf = async (opener: PublicKey, stage: string) => ({ pubkey: k(), data: await accountBytes(core, "MatchState", { inner: { game: Array.from(game.toBytes()), stage: { [stage]: {} }, id: { opener: Array.from(opener.toBytes()), n: new anchor.BN(1) }, a: { player: Array.from(opener.toBytes()) } } }) });

  it("catches an unpaired Match, an open Request and an open Offer left by an away Account, and only those", async () => {
    const w = world({
      lists: {
        ProtectionsState: [await protectionsOf(ana, NOW + 100), await protectionsOf(ben, NOW - 5)],
        MatchState: [await matchOf(ana, "open"), await matchOf(ana, "active"), await matchOf(ben, "open")],
        RequestState: [await requestOf(ana, 0), await requestOf(ana, 2), await requestOf(ben, 0)],
        OfferState: [await offerOf(ana, 0), await offerOf(ana, 2), await offerOf(ben, 0)],
      },
    });
    const r = await janitor(w.ctx, w.d, ["away"]);
    assert.deepEqual(w.sent.sort(), ["clearRequest", "expireOffer", "refundMatch"]);
    assert.equal(r.parts[0].actions, 3);
    assert.match(r.parts[0].note ?? "", /1 away Account/);
  });

  it("reads nothing but Protections while nobody is away", async () => {
    const w = world({ lists: { ProtectionsState: [await protectionsOf(ben, NOW - 5)], RequestState: [await requestOf(ben, 0)] } });
    const r = await janitor(w.ctx, w.d, ["away"]);
    assert.deepEqual(w.sent, []);
    assert.equal(r.parts[0].actions, 0);
    assert.equal("RequestState" in w.slices, false);
  });
});
