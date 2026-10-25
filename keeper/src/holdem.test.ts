import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PHASE, TABLE_PHASE } from "../../app/src/games/holdem/chain.ts";
import { needsRecommit } from "./recommit.ts";
import { holdemStep, holdemTableStep, type HoldemFacts, type HoldemTableFacts } from "./holdem.ts";

const facts = (over: Partial<HoldemFacts> = {}): HoldemFacts => ({
  assigned: true,
  ours: true,
  tablePhase: TABLE_PHASE.live,
  seatsOpen: true,
  dirty: false,
  startDeadline: 1300,
  handPhase: PHASE.preflop,
  handDeadline: 2000,
  vrfReady: false,
  finalizable: false,
  ...over,
});
const tfacts = (over: Partial<HoldemTableFacts> = {}): HoldemTableFacts => ({
  tablePhase: TABLE_PHASE.over,
  seatsOpen: false,
  dirty: false,
  sinceOver: 100,
  doneSlots: [],
  matchFrozen: false,
  recommit: false,
  ...over,
});
const DAY = 86_400;

describe("Hold'em Match step: assignment and settlement", () => {
  it("assigns a Match without a table while it can still start, and refunds one that never got a table at the deadline", () => {
    assert.equal(holdemStep(facts({ assigned: false }), 5, 10).do, "assign");
    assert.equal(holdemStep(facts({ assigned: false }), 10, 10).do, "refund");
  });

  it("finalizes as soon as base's committed table can settle the Match, whatever the live table says", () => {
    assert.equal(holdemStep(facts({ finalizable: true, tablePhase: TABLE_PHASE.over }), 5, 10).do, "finalize");
    assert.equal(holdemStep(facts({ finalizable: true, ours: false }), 5, 10).do, "finalize");
  });

  it("waits while the table is on another Match, and refunds at the Match deadline", () => {
    assert.equal(holdemStep(facts({ ours: false }), 5, 10).do, "wait");
    assert.equal(holdemStep(facts({ ours: false }), 10, 10).do, "refund");
  });
});

describe("Hold'em Match step: starting and playing", () => {
  it("begins an Idle table inside the start window only", () => {
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.idle }), 1300, 1000 + DAY).do, "begin_match");
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.idle }), 1301, 1000 + DAY).do, "wait");
  });

  it("hands the seats to the Players, waits for check-ins, and expires a start nobody finished", () => {
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.waiting, seatsOpen: false }), 1200, 1000 + DAY).do, "seat_players");
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.waiting }), 1200, 1000 + DAY).do, "wait");
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.waiting }), 1301, 1000 + DAY).do, "expire_start");
  });

  it("leaves a running hand to the Players until its clock runs out, then claims the timeout", () => {
    assert.equal(holdemStep(facts(), 1999, 1000 + DAY).do, "wait");
    assert.equal(holdemStep(facts(), 2001, 1000 + DAY).do, "claim_timeout");
  });

  it("deals a hand whose randomness arrived and nobody dealt", () => {
    assert.equal(holdemStep(facts({ handPhase: PHASE.shuffle, vrfReady: true }), 1500, 1000 + DAY).do, "deal");
    assert.equal(holdemStep(facts({ handPhase: PHASE.shuffle }), 1500, 1000 + DAY).do, "wait");
  });

  it("commits a finished table once, and then waits for the base layer", () => {
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.over, dirty: true }), 5, 10).do, "commit_table");
    assert.equal(holdemStep(facts({ tablePhase: TABLE_PHASE.over }), 5, 10).do, "wait");
  });
});

describe("Hold'em table upkeep", () => {
  it("frees a ring slot first when tesoro_core's receipt is old enough", () => {
    const s = holdemTableStep(tfacts({ dirty: true, doneSlots: [{ index: 2, match: "11111111111111111111111111111112", receiptOld: true }] }));
    assert.deepEqual([s.do, s.slot?.index], ["release_slot", 2]);
  });

  it("voids a table whose Match tesoro_core already refunded", () => {
    assert.equal(holdemTableStep(tfacts({ tablePhase: TABLE_PHASE.live, matchFrozen: true })).do, "void_table");
  });

  it("runs the order commit, wipe the seats, wait, reset", () => {
    assert.equal(holdemTableStep(tfacts({ dirty: true, seatsOpen: true })).do, "commit_table");
    assert.equal(holdemTableStep(tfacts({ seatsOpen: true })).do, "wipe_seats");
    assert.equal(holdemTableStep(tfacts({ sinceOver: 10 })).do, "wait");
    assert.equal(holdemTableStep(tfacts()).do, "reset_table");
  });

  it("commits a table whose never-begun Match was given up (Idle and dirty), and leaves a clean Idle table alone", () => {
    assert.equal(holdemTableStep(tfacts({ tablePhase: TABLE_PHASE.idle, dirty: true })).do, "commit_table");
    assert.equal(holdemTableStep(tfacts({ tablePhase: TABLE_PHASE.idle })).do, "wait");
  });

  it("does nothing for a table that is playing", () => {
    assert.equal(holdemTableStep(tfacts({ tablePhase: TABLE_PHASE.live })).do, "wait");
  });
});

describe("A commit that never reached base", () => {
  const key = (n: number) => ({ equals: (o: unknown) => o === key(n) || (o as { n?: number }).n === n, n }) as never;
  const slot = (n: number, at: number) => ({ state: 2, tesoroMatch: key(n), epoch: 3, at });
  it("repeats the commit for a result base does not show once it has waited, and not before", () => {
    const live = { ring: [slot(1, 1000)] };
    assert.equal(needsRecommit(live, { ring: [] }, 1119, 0), false);
    assert.equal(needsRecommit(live, { ring: [] }, 1120, 0), true);
    assert.equal(needsRecommit(live, null, 1120, 0), true);
  });

  it("leaves a result that base shows, a result already tried lately, and an empty ring alone", () => {
    const live = { ring: [slot(1, 1000)] };
    assert.equal(needsRecommit(live, { ring: [slot(1, 1000)] }, 5000, 0), false);
    assert.equal(needsRecommit(live, { ring: [] }, 5000, 4950), false);
    assert.equal(needsRecommit({ ring: [] }, { ring: [] }, 5000, 0), false);
  });

  it("puts the repeat before the table's usual steps", () => {
    assert.equal(holdemTableStep(tfacts({ tablePhase: TABLE_PHASE.live, recommit: true })).do, "commit_table");
    assert.equal(holdemTableStep(tfacts({ seatsOpen: true, recommit: true })).do, "commit_table");
  });
});
