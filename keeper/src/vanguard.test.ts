import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { PENDING, STATUS } from "../../app/src/games/vanguard/decode.ts";
import { CU, SLOT, TABLE_PHASE, type TableState } from "../../app/src/games/vanguard/chain.ts";
import { GRACE_SECS, SETUP_ASSIST_SECS, setupMove, vanguardStep, vanguardTableFacts, type VanguardFacts } from "./vanguard.ts";
import { holdemTableStep } from "./holdem.ts";

const DAY = 86_400;
const facts = (over: Partial<VanguardFacts> = {}): VanguardFacts => ({
  assigned: true,
  ours: true,
  tablePhase: TABLE_PHASE.live,
  seatsOpen: true,
  dirty: false,
  startDeadline: 1300,
  status: STATUS.live,
  entropyDeadline: 1400,
  setupDeadline: 1480,
  deadline: 2000,
  capDeadline: 3000,
  pendingKind: PENDING.none,
  pendingSlot: 0n,
  finalizable: false,
  ...over,
});
const step = (f: VanguardFacts, now: number, slot = 100n) => vanguardStep(f, now, 1000 + DAY, slot);

describe("Vanguard Match step: assignment and settlement", () => {
  it("assigns a Match without a table while it can still start, and refunds one that never got a table at the deadline", () => {
    assert.equal(vanguardStep(facts({ assigned: false }), 5, 10, 0n).do, "assign");
    assert.equal(vanguardStep(facts({ assigned: false }), 10, 10, 0n).do, "refund");
  });

  it("finalizes as soon as base's committed table can settle the Match, whatever the live table says", () => {
    assert.equal(step(facts({ finalizable: true, tablePhase: TABLE_PHASE.over }), 5).do, "finalize");
    assert.equal(step(facts({ finalizable: true, ours: false }), 5).do, "finalize");
  });

  it("waits while the table is on another Match, and refunds at the Match deadline", () => {
    assert.equal(vanguardStep(facts({ ours: false }), 5, 10, 0n).do, "wait");
    assert.equal(vanguardStep(facts({ ours: false }), 10, 10, 0n).do, "refund");
  });
});

describe("Vanguard Match step: starting", () => {
  it("begins an Idle table inside the start window only", () => {
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.idle }), 1300).do, "begin_match");
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.idle }), 1301).do, "wait");
  });

  it("hands the seats to the Players, waits for check-ins, and cancels a start nobody finished", () => {
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.waiting, seatsOpen: false, status: STATUS.created }), 1200).do, "seat_players");
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.waiting, status: STATUS.created }), 1200).do, "wait");
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.waiting, status: STATUS.created }), 1300).do, "wait");
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.waiting, status: STATUS.created }), 1301).do, "claim_timeout");
  });
});

describe("Vanguard Match step: the rollup", () => {
  it("resolves a pending action once the slot is past its declare slot", () => {
    const f = facts({ pendingKind: PENDING.move, pendingSlot: 100n });
    assert.equal(step(f, 1500, 101n).do, "resolve");
    assert.equal(step(f, 1500, 100n).do, "wait");
    assert.equal(step(facts({ pendingKind: PENDING.timeout, pendingSlot: 5n }), 1500, 6n).do, "resolve");
    assert.equal(step(facts({ pendingKind: PENDING.cap, pendingSlot: 5n }), 1500, 6n).do, "resolve");
  });

  it("resolves a declared Blast, Rescue or pass like a move (a pass names no piece, so nothing else differs)", () => {
    for (const pendingKind of [PENDING.blast, PENDING.rescue, PENDING.pass]) {
      const f = facts({ pendingKind, pendingSlot: 100n });
      assert.equal(step(f, 1500, 101n).do, "resolve", `kind ${pendingKind}`);
      assert.equal(step(f, 1500, 100n).do, "wait", `kind ${pendingKind} in its declare slot`);
    }
  });

  it("resolves before it considers any clock", () => {
    const f = facts({ pendingKind: PENDING.move, pendingSlot: 1n, deadline: 10, capDeadline: 10 });
    assert.equal(step(f, 5000, 2n).do, "resolve");
  });

  it("helps setup along inside its window and cancels it once past the entropy or setup deadline", () => {
    const f = facts({ status: STATUS.setup });
    assert.equal(step(f, 1400 + GRACE_SECS).do, "assist_setup");
    assert.equal(step(f, 1401 + GRACE_SECS).do, "claim_timeout");
  });

  it("claims a timeout only GRACE_SECS after an expired turn", () => {
    assert.equal(step(facts(), 2000 + GRACE_SECS).do, "wait");
    assert.equal(step(facts(), 2001 + GRACE_SECS).do, "claim_timeout");
  });

  it("claims the time cap GRACE_SECS after it, even while the turn clock is fresh", () => {
    const f = facts({ deadline: 9999 });
    assert.equal(step(f, 3000 + GRACE_SECS).do, "wait");
    assert.equal(step(f, 3001 + GRACE_SECS).do, "claim_timeout");
  });

  it("commits an Over table once, and then waits for base to show it", () => {
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.over, status: STATUS.over, dirty: true }), 5).do, "commit_table");
    assert.equal(step(facts({ tablePhase: TABLE_PHASE.over, status: STATUS.over }), 5).do, "wait");
  });

  it("refunds an unfinished Match at the tesoro_core deadline whatever the rollup last showed", () => {
    for (const status of [STATUS.setup, STATUS.live]) {
      assert.equal(vanguardStep(facts({ status }), 10, 10, 0n).do, "refund");
      assert.equal(vanguardStep(facts({ status, pendingKind: PENDING.move, pendingSlot: 1n }), 11, 10, 9n).do, "refund");
      assert.notEqual(vanguardStep(facts({ status }), 9, 10, 0n).do, "refund");
    }
    assert.equal(vanguardStep(facts({ tablePhase: TABLE_PHASE.over, dirty: true }), 11, 10, 0n).do, "commit_table");
  });

  it("always says why it waits", () => {
    assert.match(step(facts(), 1500).why, /turn|deadline/i);
  });
});

describe("setup that stalls", () => {
  it("deals when the deal would go through, whatever the randomness request did", () => {
    assert.equal(setupMove({ canDeal: true, canRequest: true, now: 100, setupStartedAt: 0 }), "deal");
  });

  it("asks for the randomness once both secrets are in and the Match's request was not made", () => {
    assert.equal(setupMove({ canDeal: false, canRequest: true, now: 100 + SETUP_ASSIST_SECS, setupStartedAt: 100 }), "request_vrf");
  });

  it("leaves the first seconds to the Players' clients, and does nothing while a secret is missing or the request was made", () => {
    assert.equal(setupMove({ canDeal: false, canRequest: true, now: 103, setupStartedAt: 100 }), "wait");
    assert.equal(setupMove({ canDeal: false, canRequest: false, now: 500, setupStartedAt: 100 }), "wait");
  });
});

describe("table upkeep", () => {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
  const table = (over: Partial<TableState> = {}): TableState => ({
    address: key(9),
    generation: 0,
    index: 0,
    epoch: 3,
    phase: TABLE_PHASE.over,
    seatsCreated: true,
    seatsOpen: true,
    dirty: false,
    tesoroMatch: key(1),
    slot: 0,
    startDeadline: 0,
    checkedIn: [true, true],
    overAt: 1000,
    reqNonce: 0,
    reqPending: false,
    reqMade: true,
    vrfReady: false,
    ring: [{ state: SLOT.done, tesoroMatch: key(1), epoch: 3, outcome: 1, at: 1000 }],
    ...over,
  });

  it("wipes the seats of a committed finished table, then resets it after the delay", () => {
    const t = table();
    const f = (now: number) => vanguardTableFacts(t, now, () => null, table(), 0);
    assert.equal(holdemTableStep(f(1010)).do, "wipe_seats");
    assert.equal(holdemTableStep(vanguardTableFacts({ ...t, seatsOpen: false }, 1010, () => null, table(), 0)).do, "wait");
    assert.equal(holdemTableStep(vanguardTableFacts({ ...t, seatsOpen: false }, 1030, () => null, table(), 0)).do, "reset_table");
  });

  it("commits a dirty table, frees a slot whose receipt is a minute old, and voids a table whose Match tesoro_core refunded", () => {
    assert.equal(holdemTableStep(vanguardTableFacts(table({ dirty: true }), 1010, () => null, null, 0)).do, "commit_table");
    assert.equal(holdemTableStep(vanguardTableFacts(table(), 1100, () => 70, table(), 0)).do, "release_slot");
    const live = table({ phase: TABLE_PHASE.live, ring: [] });
    assert.equal(holdemTableStep(vanguardTableFacts(live, 1100, () => 70, null, 0)).do, "void_table");
  });
});

describe("compute budgets", () => {
  // ticket vgp 06, LiteSVM on compiled SBF: the worst declare and resolve, 30% headroom
  it("cover the program's worst measured declare and resolve with 30% headroom", () => {
    assert.ok(CU.declare >= 5_090 * 1.3, `declare budget ${CU.declare}`);
    assert.ok(CU.resolve >= 146_052 * 1.3, `resolve budget ${CU.resolve}`);
  });
});
