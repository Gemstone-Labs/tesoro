import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PHASE } from "../../app/src/games/trading-duel/chain.ts";
import { duelStep, END_GRACE_SECS, type DuelFacts } from "./duel.ts";
import { tableStep, type TableFacts } from "./tables.ts";

const facts = (over: Partial<DuelFacts> = {}): DuelFacts => ({
  assigned: true,
  ours: true,
  phase: PHASE.live,
  seatsOpen: true,
  dirty: false,
  startDeadline: 1300,
  startsAt: 1850,
  endsAt: 2000,
  finalizable: false,
  ...over,
});
const DAY = 86_400;

describe("Trading Duel Match step: assignment and settlement", () => {
  it("assigns a Match without a table while it can still start, and refunds one that never got a table at the deadline", () => {
    assert.equal(duelStep(facts({ assigned: false }), 5, 10).do, "assign");
    assert.equal(duelStep(facts({ assigned: false }), 10, 10).do, "refund");
  });

  it("finalizes as soon as base's committed table can settle the Match, whatever the live table says", () => {
    assert.equal(duelStep(facts({ finalizable: true, phase: PHASE.over }), 5, 10).do, "finalize");
    assert.equal(duelStep(facts({ finalizable: true, ours: false }), 5, 10).do, "finalize");
  });

  it("waits while the table is on another Match, and refunds at the Match deadline", () => {
    assert.equal(duelStep(facts({ ours: false }), 5, 10).do, "wait");
    assert.equal(duelStep(facts({ ours: false }), 10, 10).do, "refund");
  });
});

describe("Trading Duel Match step: starting", () => {
  it("begins an Idle table inside the start window only", () => {
    assert.equal(duelStep(facts({ phase: PHASE.idle }), 1300, 1000 + DAY).do, "begin_match");
    assert.equal(duelStep(facts({ phase: PHASE.idle }), 1301, 1000 + DAY).do, "wait");
  });

  it("opens the Books of a begun Match, then waits for the Players to check in", () => {
    assert.equal(duelStep(facts({ phase: PHASE.waiting, seatsOpen: false }), 1000, 0).do, "open_seats");
    assert.equal(duelStep(facts({ phase: PHASE.waiting }), 1000, 0).do, "wait");
  });

  it("expires a Match whose Players did not both check in before the start deadline (the no-show refund)", () => {
    assert.equal(duelStep(facts({ phase: PHASE.waiting }), 1300, 0).do, "wait");
    assert.equal(duelStep(facts({ phase: PHASE.waiting }), 1301, 0).do, "expire_start");
  });
});

describe("Trading Duel Match step: playing and committing", () => {
  it("ticks a live Match while the grid runs, from its start to its end", () => {
    assert.equal(duelStep(facts(), 1849, 0).do, "wait");
    assert.equal(duelStep(facts(), 1850, 0).do, "tick");
    assert.equal(duelStep(facts(), 1999, 0).do, "tick");
  });

  it("leaves the first try at ending to the Players, then ends the Match", () => {
    assert.equal(duelStep(facts(), 2000, 0).do, "wait");
    assert.equal(duelStep(facts(), 2000 + END_GRACE_SECS - 1, 0).do, "wait");
    assert.equal(duelStep(facts(), 2000 + END_GRACE_SECS, 0).do, "end_match");
  });

  it("commits a finished table once (only while it is dirty)", () => {
    assert.equal(duelStep(facts({ phase: PHASE.over, dirty: true }), 1, 0).do, "commit_table");
    assert.equal(duelStep(facts({ phase: PHASE.over, dirty: false }), 1, 10).do, "wait");
  });
});

const table = (over: Partial<TableFacts> = {}): TableFacts => ({ phase: PHASE.over, seatsOpen: false, dirty: false, sinceOver: 100, doneSlots: [], matchFrozen: false, recommit: false, ...over });

describe("Trading Duel table upkeep", () => {
  it("moves a finished table along: commit, close the Books, wait out the delay, reset", () => {
    assert.equal(tableStep(table({ dirty: true, seatsOpen: true })).do, "commit_table");
    assert.equal(tableStep(table({ seatsOpen: true })).do, "close_seats");
    assert.equal(tableStep(table({ sinceOver: 29 })).do, "wait");
    assert.equal(tableStep(table({ sinceOver: 30 })).do, "reset_table");
  });

  it("commits a table whose never-begun Match was given up (Idle and dirty)", () => {
    assert.equal(tableStep(table({ phase: PHASE.idle, dirty: true })).do, "commit_table");
    assert.equal(tableStep(table({ phase: PHASE.live, dirty: true })).do, "wait");
  });

  it("leaves a table that is idle or running alone", () => {
    assert.equal(tableStep(table({ phase: PHASE.idle })).do, "wait");
    assert.equal(tableStep(table({ phase: PHASE.live })).do, "wait");
  });

  it("frees a ring slot once tesoro_core's receipt for its Match is old enough, before anything else", () => {
    const m = "11111111111111111111111111111111";
    const slots = [{ index: 2, match: m, receiptOld: false }, { index: 5, match: m, receiptOld: true }];
    const step = tableStep(table({ phase: PHASE.live, doneSlots: slots }));
    assert.equal(step.do, "release_slot");
    assert.equal(step.slot?.index, 5);
    assert.equal(tableStep(table({ phase: PHASE.live, doneSlots: [slots[0]] })).do, "wait");
  });

  it("gives up a table whose Match tesoro_core already refunded", () => {
    assert.equal(tableStep(table({ phase: PHASE.live, matchFrozen: true })).do, "void_table");
    assert.equal(tableStep(table({ phase: PHASE.waiting, matchFrozen: true })).do, "void_table");
    assert.equal(tableStep(table({ phase: PHASE.over, matchFrozen: true })).do, "reset_table");
  });
});
