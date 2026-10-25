import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { CHECKIN_SLOTS, END_OFFSET_SLOTS, FREEZE_OFFSET_SLOTS, SEED_RETRY_SECS, SEED_SLOTS, SLOTS_PER_SEC, TABLE_PHASE } from "../../app/src/games/block-puzzle/live-chain.ts";
import { burstStep, burstTableStep, RESET_DELAY_SECS, type BurstFacts, type BurstTableFacts } from "./burst.ts";

const NOW = 10_000;
const DEADLINE = NOW + 86_400;
const base = (over: Partial<BurstFacts> = {}): BurstFacts => ({
  assigned: true,
  ours: true,
  tablePhase: TABLE_PHASE.idle,
  seatsOpen: false,
  dirty: false,
  startDeadline: NOW + 200,
  slot: 1_000_000,
  assignedSlot: 1_000_000,
  seedingSlot: 0,
  startSlot: 0,
  seedReady: false,
  reqPending: false,
  reqSlot: 0,
  reqCount: 0,
  finalizable: false,
  ...over,
});
const step = (over: Partial<BurstFacts>, now = NOW) => burstStep(base(over), now, DEADLINE).do;

describe("Block Burst Match step", () => {
  it("assigns a Match without a table, and refunds it past the Match deadline", () => {
    assert.equal(step({ assigned: false }), "assign");
    assert.equal(step({ assigned: false }, DEADLINE), "refund");
  });

  it("finalizes as soon as base's committed table can settle it, whatever else is going on", () => {
    assert.equal(step({ finalizable: true, tablePhase: TABLE_PHASE.getReady, ours: false }), "finalize");
  });

  it("waits while the table is on another Match, and refunds past the deadline", () => {
    assert.equal(step({ ours: false }), "wait");
    assert.equal(step({ ours: false }, DEADLINE), "refund");
  });

  it("begins an Idle table inside the start window only", () => {
    assert.equal(step({}), "begin_match");
    assert.equal(step({ startDeadline: NOW - 1 }), "wait");
  });

  it("seats the Players, waits for check-ins, closes when the window is over", () => {
    assert.equal(step({ tablePhase: TABLE_PHASE.assigned }), "seat_players");
    assert.equal(step({ tablePhase: TABLE_PHASE.assigned, seatsOpen: true }), "wait");
    const a = { tablePhase: TABLE_PHASE.assigned, seatsOpen: true, assignedSlot: 5_000 };
    assert.equal(step({ ...a, slot: 5_000 + CHECKIN_SLOTS }), "wait");
    assert.equal(step({ ...a, slot: 5_000 + CHECKIN_SLOTS + 1 }), "close");
    // Even with the seats not handed over: a window that ran out is closed, not seated.
    assert.equal(step({ tablePhase: TABLE_PHASE.assigned, assignedSlot: 5_000, slot: 5_000 + CHECKIN_SLOTS + 1 }), "close");
  });

  it("asks for the Seed once, retries a late answer every 20 s up to 3 times, starts when it is in", () => {
    const s = { tablePhase: TABLE_PHASE.seeding, seatsOpen: true, seedingSlot: 5_000 };
    assert.equal(step({ ...s, slot: 5_010 }), "request_seed");
    const asked = { ...s, reqCount: 1, reqPending: true, reqSlot: 5_010 };
    assert.equal(step({ ...asked, slot: 5_010 + SEED_RETRY_SECS * SLOTS_PER_SEC - 1 }), "wait");
    assert.equal(step({ ...asked, slot: 5_010 + SEED_RETRY_SECS * SLOTS_PER_SEC }), "request_seed");
    assert.equal(step({ ...asked, reqCount: 3, slot: 5_010 + SEED_RETRY_SECS * SLOTS_PER_SEC }), "wait");
    assert.equal(step({ ...asked, seedReady: true, slot: 5_020 }), "start");
  });

  it("closes a Seed window that ran out, even if the Seed came late", () => {
    const s = { tablePhase: TABLE_PHASE.seeding, seatsOpen: true, seedingSlot: 5_000 };
    assert.equal(step({ ...s, slot: 5_000 + SEED_SLOTS }), "request_seed");
    assert.equal(step({ ...s, slot: 5_000 + SEED_SLOTS + 1, seedReady: true }), "close");
  });

  it("leaves the run to the Players and closes after the window and its grace", () => {
    const r = { tablePhase: TABLE_PHASE.getReady, seatsOpen: true, startSlot: 9_000, seedReady: true };
    assert.equal(step({ ...r, slot: 8_000 }), "wait");
    assert.equal(step({ ...r, slot: 9_000 + END_OFFSET_SLOTS }), "wait");
    assert.equal(step({ ...r, slot: 9_000 + END_OFFSET_SLOTS + 1 }), "close");
    // The hidden window (ticket 43): the keeper never closes, commits or otherwise touches the table between the freeze
    // and the end of the grace, whatever the boards look like, so its transactions add no timing of their own.
    for (let slot = 9_000 + FREEZE_OFFSET_SLOTS; slot <= 9_000 + END_OFFSET_SLOTS; slot += 25) assert.equal(step({ ...r, slot }), "wait", `slot ${slot}`);
  });

  it("commits a closed table once, then waits for base", () => {
    assert.equal(step({ tablePhase: TABLE_PHASE.closed, dirty: true }), "commit_table");
    assert.equal(step({ tablePhase: TABLE_PHASE.closed }), "wait");
  });
});

const tbl = (over: Partial<BurstTableFacts> = {}): BurstTableFacts => ({
  tablePhase: TABLE_PHASE.idle,
  seatsOpen: false,
  dirty: false,
  sinceOver: 0,
  doneSlots: [],
  matchFrozen: false,
  recommit: false,
  ...over,
});
const m1 = new PublicKey(Buffer.alloc(32, 1)).toBase58();

describe("Block Burst table upkeep", () => {
  it("frees a ring slot first, then voids, repeats a lost commit, commits, wipes, resets", () => {
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.closed, dirty: true, doneSlots: [{ index: 2, match: m1, receiptOld: true }] })).do, "release_slot");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.getReady, matchFrozen: true })).do, "void_table");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.idle, recommit: true })).do, "commit_table");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.closed, dirty: true })).do, "commit_table");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.closed, seatsOpen: true })).do, "wipe_seats");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.closed, sinceOver: RESET_DELAY_SECS - 1 })).do, "wait");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.closed, sinceOver: RESET_DELAY_SECS })).do, "reset_table");
  });

  it("commits a table whose never-begun Match was given up (Idle and dirty)", () => {
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.idle, dirty: true })).do, "commit_table");
    assert.equal(burstTableStep(tbl({ tablePhase: TABLE_PHASE.idle })).do, "wait");
  });

  it("never touches a table in the middle of a Match", () => {
    for (const p of [TABLE_PHASE.assigned, TABLE_PHASE.seeding, TABLE_PHASE.getReady]) assert.equal(burstTableStep(tbl({ tablePhase: p, seatsOpen: true })).do, "wait");
  });
});
