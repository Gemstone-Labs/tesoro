// Bytes produced by the programs' own Rust code (`keeper_fixtures` tests in tesoro_core and tesoro_bridge write
// keeper/fixtures/*.json), decoded by the keeper's readers. A layout change in a program fails the Rust test until the
// files are regenerated, and then fails here if the keeper was not updated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { OUTCOME, PHASE, SLOT, STATUS, decodeAssignment, decodeBook, decodeDuel, decodeTable, canFinalizeTable, slotOf } from "../../app/src/games/trading-duel/chain.ts";
import { OUTCOME as BB_OUTCOME, REASON as BB_REASON, TABLE_PHASE as BB_PHASE, decodeTable as decodeBurstTable, runLogOf as burstRunLog } from "../../app/src/games/block-puzzle/live-chain.ts";
import { decodeMatchRecords } from "../../app/src/server/history/events.ts";
import { decodeBatch, decodeClaim, decodePayout, decodeRoute } from "./bridge-ix.ts";
import { counterAmounts } from "./counters.ts";
import { CORE_ID, decodeStore, decodeTicketHead, eventAuthority, POT_AT } from "./kit.ts";
import { orderOf } from "./orders.ts";
import { loadIdl } from "./runtime.ts";
import { viewOf } from "./settle.ts";
import { seasonOf } from "./season.ts";
import { bookCheckpointCounts } from "./supply.ts";

const load = (name: string): Record<string, Buffer> => Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]));
const core = load("core-layouts");
const bridge = load("bridge-layouts");
const duelFx = load("trading-duel-layouts");
const burstFx = load("block-puzzle-layouts");
// the coder the keeper really uses (camelCase fields)
const coder = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {})).coder.accounts;
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};

describe("line stores written by tesoro_core", () => {
  it("a basket: account, room held, first slot and the lines that remain", () => {
    const st = decodeStore(core.basket);
    assert.equal(st.account.toBase58(), keyOf(9).toBase58());
    assert.deepEqual([st.len, st.capacity, st.roomReserved], [2, 5, 4]);
    // the own line (side 0) was removed; the won lines sort by due_at: 50 (source 2, 22 Gemas) then 70 (class 1, source 3)
    const [a, b] = st.lines();
    assert.deepEqual([a.side, a.cls, a.dueAt, a.source.toBase58(), a.amount], [1, 3, 50n, keyOf(2).toBase58(), 22n]);
    assert.deepEqual([b.side, b.cls, b.dueAt, b.source.toBase58(), b.amount], [1, 1, 70n, keyOf(3).toBase58(), 33n]);
  });

  it("a spill with reserved slots", () => {
    const st = decodeStore(core.spill);
    assert.equal(st.account.toBase58(), keyOf(8).toBase58());
    assert.deepEqual([st.len, st.capacity, st.roomReserved, st.first], [2, 3, 2, 0]);
    assert.deepEqual(st.lines().map((l) => l.amount), [11n, 22n]);
  });

  it("a Ticket: head fields and Pot lines", () => {
    const t = decodeTicketHead(core.ticket);
    assert.deepEqual([t.kind, t.state, t.nonce, t.target, t.expiresAt, t.spillRoom], ["backing", "cancelling", 77n, 5000n, 1_800_000_000, 6]);
    assert.deepEqual([t.account.toBase58(), t.game.toBase58(), t.payer.toBase58()], [keyOf(5).toBase58(), keyOf(6).toBase58(), keyOf(7).toBase58()]);
    const pot = decodeStore(core.ticket, POT_AT);
    assert.deepEqual(pot.lines().map((l) => [l.side, l.amount]), [[0, 11n], [1, 22n]]);
  });
});

describe("a Source book written by tesoro_core", () => {
  it("fee counters and the closed-segment count of every class", () => {
    assert.deepEqual(counterAmounts(core.book), [1001n, 2002n, 3003n]);
    assert.deepEqual(bookCheckpointCounts(core.book), [10, 11, 12, 13, 14]);
  });
});

describe("Borsh accounts written by tesoro_core, read through the IDL", () => {
  it("an Instant Redeem order", () => {
    const o = orderOf(keyOf(99), coder.decode("instantOrderState", core.order));
    assert.deepEqual([o.account.toBase58(), o.owner.toBase58(), o.payer.toBase58(), o.source.toBase58(), o.open, o.createdAt, o.expiresAt], [keyOf(10).toBase58(), keyOf(11).toBase58(), keyOf(13).toBase58(), keyOf(12).toBase58(), 4444n, 1_790_000_000, 1_790_086_400]);
  });

  it("a recorded Season: ranks, budget lines, payout cursor, void mask", () => {
    const s = seasonOf(coder.decode("seasonState", core.season));
    assert.deepEqual([s.number, s.count, s.recordedAt, s.voidedMask, s.closed], [4, 3, 1_795_000_000, 2, false]);
    assert.deepEqual(s.winners.map((w) => w.toBase58()), [20, 21, 22].map((n) => keyOf(n).toBase58()));
    assert.deepEqual(s.points, [100n, 99n, 98n]);
    assert.deepEqual(s.cursor.slice(0, 3), [1, 0, 0]);
    assert.deepEqual(s.lines.map((l) => [l.source.toBase58(), l.amount, l.paid]), [[keyOf(30).toBase58(), 1000n, 250n], [keyOf(31).toBase58(), 2000n, 0n]]);
  });
});

describe("a Match written by tesoro_core", () => {
  it("room holds, payer and Pots are read where the program wrote them", () => {
    const v = viewOf(keyOf(98), coder.decode("matchState", core.match));
    assert.deepEqual(v.room.map((r) => [r.account.toBase58(), r.left]), [0, 1, 2, 3, 4].map((i) => [new PublicKey(Buffer.alloc(32, 40 + i)).toBase58(), 3 + i]));
    assert.equal(v.stage, "settling");
    assert.equal(v.ref.n, 2n ** 64n - 1n);
    assert.equal(v.pots.length, 2);
  });
});

describe("event-CPI records written by tesoro_core", () => {
  const TAG = Buffer.from("e445a52e51cb9a1d", "hex");
  const inner = (data: Buffer) => [{ programId: CORE_ID.toBase58(), accounts: [eventAuthority.toBase58()], data: Buffer.concat([TAG, data]) }];

  it("MatchRunStarted", () => {
    const [r] = decodeMatchRecords(inner(core.matchRunStarted));
    assert.equal(r.type, "start");
    if (r.type !== "start") return;
    assert.deepEqual([r.opener, r.n, r.kind, r.winnerSide, r.entry, r.fees, r.challenge, r.asset, r.openedAt, r.ts, r.aShareBps, r.bShareBps], [keyOf(40).toBase58(), 12n, 0, 1, 500, [10, 15, 5], true, 1, 1_790_000_000, 1_790_000_900, 2500, 0]);
    assert.deepEqual([r.aPlayer, r.aFunder, r.bPlayer, r.bFunder], [42, 43, 44, 45].map((n) => keyOf(n).toBase58()));
  });

  it("MatchWon", () => {
    const [r] = decodeMatchRecords(inner(core.matchWon));
    assert.equal(r.type, "won");
    if (r.type !== "won") return;
    assert.deepEqual([r.winner, r.funder, r.loser, r.points, r.poolFee, r.season, r.entry], [keyOf(44).toBase58(), keyOf(45).toBase58(), keyOf(42).toBase58(), 5, 5, 4, 500]);
  });
});

describe("bridge accounts written by tesoro_bridge", () => {
  it("a VaultRoute", () => {
    const r = decodeRoute(keyOf(1), bridge.route);
    assert.deepEqual([r.eid, r.escrowEnabled, r.minBatchUnits, r.lastBatchId, r.lastPayoutId, r.escrowShares, r.escrowUnits, r.issuedShares, r.issuedUnits, r.lastFundedSeason], [40_449, true, 1000n, 7n, 9n, 11n, 12n, 13n, 14n, 15]);
    assert.deepEqual([r.peerAddress, r.asset], [Buffer.alloc(32, 3), Buffer.alloc(32, 4)]);
  });

  it("a Batch", () => {
    const b = decodeBatch(keyOf(1), bridge.batch);
    assert.deepEqual([b.eid, b.id, b.kind, b.state, b.count, b.totalUnits, b.paidUnits, b.sends], [40_449, 21n, 1, 1, 2, 120n, 20n, 3]);
    assert.equal(b.rentPayer.toBase58(), new PublicKey(Buffer.alloc(32, 5)).toBase58());
  });

  it("a PayoutRecord", () => {
    const p = decodePayout(keyOf(1), bridge.payout);
    assert.deepEqual([p.eid, p.id, p.state, p.gemas, p.shares], [40_449, 22n, 0, 345n, 6789n]);
    assert.deepEqual([p.holderAccount.toBase58(), p.prizeSource.toBase58()], [new PublicKey(Buffer.alloc(32, 10)).toBase58(), new PublicKey(Buffer.alloc(32, 12)).toBase58()]);
  });

  it("a Claim and an InstantClaim", () => {
    const c = decodeClaim(keyOf(1), bridge.claim);
    assert.deepEqual([c.unitsTotal, c.unitsSent, c.holderAccount.toBase58()], [200n, 50n, new PublicKey(Buffer.alloc(32, 13)).toBase58()]);
    const i = decodeClaim(keyOf(1), bridge.instantClaim);
    assert.deepEqual([i.unitsTotal, i.unitsSent, i.position.toBase58()], [201n, 51n, new PublicKey(Buffer.alloc(32, 18)).toBase58()]);
  });
});

// Trading Duel tables, through the same IDL coder the keeper's TradingDuelChain uses.
describe("Trading Duel accounts written by trading_duel", () => {
  const duelCoder = new anchor.Program(loadIdl("trading_duel"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {})).coder.accounts;

  it("a table with its ring, and the Match's turn on it", () => {
    const t = decodeTable(keyOf(1), duelCoder.decode("table", duelFx.table));
    assert.deepEqual([t.generation, t.index, t.epoch, t.phase, t.seatsOpen, t.dirty, t.slot], [1, 3, 7, PHASE.live, true, true, 3]);
    assert.deepEqual([t.startsAt, t.endsAt, t.overAt, t.scores, t.winner], [1000, 1150, 1151, [100, 200], 1]);
    const done = slotOf(t, keyOf(9), 6)!;
    assert.deepEqual([done.state, done.outcome, done.at], [SLOT.done, OUTCOME.win1, 1200]);
    assert.equal(t.ring[3].state, SLOT.reserved);
    const a = decodeAssignment(keyOf(5), duelCoder.decode("assignment", duelFx.assignment));
    assert.deepEqual([a.generation, a.index, a.epoch, a.startDeadline], [1, 3, 7, 1300]);
    assert.equal(decodeDuel(a, t)?.status, STATUS.live);
    assert.equal(decodeDuel({ ...a, epoch: 6 }, t), null);
  });

  it("base's copy settles a Match with a Done result, or after the table moved past its epoch", () => {
    const t = decodeTable(keyOf(1), duelCoder.decode("table", duelFx.table));
    const a = decodeAssignment(keyOf(5), duelCoder.decode("assignment", duelFx.assignment));
    assert.equal(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(9), epoch: 6 }, 2000), true);
    assert.equal(canFinalizeTable(t, a, 2000), false); // Reserved: still running
    assert.equal(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(8), epoch: 6 }, 1300), false);
    assert.equal(canFinalizeTable(t, { ...a, tesoroMatch: keyOf(8), epoch: 6 }, 1301), true); // table epoch 7 > 6, no slot
  });

  it("a Book and the table config", () => {
    const b = decodeBook(keyOf(60), duelCoder.decode("book", duelFx.book));
    assert.deepEqual([b.seat, b.pickCount, b.picks[2], b.picks[11]], [1, 2, 6, -3]);
    const c: any = duelCoder.decode("tableConfig", duelFx.table_config);
    assert.deepEqual([c.generation, c.maxTables], [1, 4]);
  });
});

describe("Block Burst accounts written by block_puzzle", () => {
  const coder = new anchor.Program(loadIdl("block_puzzle"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {})).coder.accounts;
  it("a running table and its Done result with the run log, through the keeper's decoder", () => {
    const t = decodeBurstTable(keyOf(1), coder.decode("table", burstFx.table));
    assert.deepEqual([t.generation, t.index, t.epoch, t.phase, t.startSlot, t.seedReady], [1, 3, 7, BB_PHASE.getReady, 51900, true]);
    const log = burstRunLog(t, keyOf(9), 6)!;
    assert.deepEqual([log.scores, log.counts, log.reason], [[18, 77], [3, 4], BB_REASON.played]);
    assert.equal(t.ring[1].outcome, BB_OUTCOME.win1);
  });
  it("a closed table says why", () => {
    const t = decodeBurstTable(keyOf(1), coder.decode("table", burstFx.closed_table));
    assert.deepEqual([t.phase, t.reason, t.outcome], [BB_PHASE.closed, BB_REASON.absent, BB_OUTCOME.win0]);
  });
});
