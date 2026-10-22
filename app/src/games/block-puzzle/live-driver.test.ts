import { describe, expect, it } from "vitest";
import { ASSIGNED, SECS, blankTable, fixtureAssignment, fixtureBoard } from "./live-fixtures";
import { CHECKIN_SLOTS, REASON, SEED_RETRY_SLOTS, SLOT, TABLE_PHASE, type Table } from "./live-chain";
import { OPENER_EXTRA_MS, STEP_IN_MS, nextStep, steppedIn, type DriveInput } from "./live-driver";

const START = ASSIGNED + 70 * SECS;
const LATE = STEP_IN_MS + OPENER_EXTRA_MS;

const seated = (over: Partial<Table> = {}) => blankTable({ phase: TABLE_PHASE.assigned, seatsOpen: true, ...over });
const seeding = (over: Partial<Table> = {}) => seated({ phase: TABLE_PHASE.seeding, checkedIn: [true, true], seedingSlot: ASSIGNED + 20 * SECS, ...over });
const running = (over: Partial<Table> = {}) => seeding({ phase: TABLE_PHASE.getReady, seedReady: true, startSlot: START, ...over });

function input(over: Partial<DriveInput> = {}): DriveInput {
  return { seat: 1, status: "active", assignment: fixtureAssignment({ startDeadline: 5_000 }), table: seated(), baseTable: null, slot: ASSIGNED + 5 * SECS, nowS: 1_000, board: null, stalledMs: 0, ...over };
}
const kind = (i: DriveInput) => nextStep(i).kind;

describe("nextStep", () => {
  it("does nothing for a Match that is over", () => {
    expect(kind(input({ status: "settled" }))).toBe("done");
    expect(kind(input({ status: "refunded" }))).toBe("done");
  });

  it("waits for an opponent while the Match is open", () => {
    expect(nextStep(input({ status: "open", assignment: null }))).toEqual({ kind: "wait", why: "opponent" });
  });

  it("waits for a table until the operator has written the Assignment", () => {
    expect(nextStep(input({ assignment: null, table: null }))).toEqual({ kind: "wait", why: "table" });
  });

  it("waits when the table cannot be read", () => {
    expect(nextStep(input({ table: null }))).toEqual({ kind: "wait", why: "setup" });
  });

  describe("begin_match", () => {
    const idle = { table: blankTable({ phase: TABLE_PHASE.idle }) };
    it("leaves it to the keeper at first", () => expect(nextStep(input(idle))).toEqual({ kind: "wait", why: "setup" }));
    it("does it when the table has not moved (keeper down)", () => expect(kind(input({ ...idle, stalledMs: LATE }))).toBe("beginMatch"));
    it("not after the start window: tesoro_core refunds at its deadline", () => expect(nextStep(input({ ...idle, stalledMs: LATE, nowS: 5_001 }))).toEqual({ kind: "wait", why: "setup" }));
  });

  describe("seat_players", () => {
    const closedSeats = { table: seated({ seatsOpen: false }) };
    it("waits for the keeper", () => expect(nextStep(input(closedSeats))).toEqual({ kind: "wait", why: "setup" }));
    it("does it when stalled (keeper down)", () => expect(kind(input({ ...closedSeats, stalledMs: LATE }))).toBe("seatPlayers"));
  });

  describe("check_in", () => {
    it("checks in at once: it is the Player's own step", () => expect(kind(input({ table: seated() }))).toBe("checkIn"));
    it("each seat checks itself in", () => {
      expect(kind(input({ seat: 0, table: seated({ checkedIn: [false, true] }) }))).toBe("checkIn");
      expect(nextStep(input({ seat: 0, table: seated({ checkedIn: [true, false] }) }))).toEqual({ kind: "wait", why: "opponent" });
    });
    it("a window that passed is closed by anyone, after a pause", () => {
      const over = { table: seated({ checkedIn: [true, false] }), slot: ASSIGNED + CHECKIN_SLOTS + 1 };
      expect(nextStep(input(over))).toEqual({ kind: "wait", why: "result" });
      expect(kind(input({ ...over, stalledMs: LATE }))).toBe("close");
    });
  });

  describe("request_seed", () => {
    it("waits for the keeper", () => expect(nextStep(input({ table: seeding() }))).toEqual({ kind: "wait", why: "seed" }));
    it("asks when nothing has been asked and the table is stalled", () => expect(kind(input({ table: seeding(), stalledMs: LATE }))).toBe("requestSeed"));
    it("does not ask again while a request is outstanding and young", () => {
      const t = seeding({ reqPending: true, reqCount: 1, reqSlot: ASSIGNED + 21 * SECS });
      expect(kind(input({ table: t, slot: ASSIGNED + 30 * SECS, stalledMs: LATE }))).toBe("wait");
    });
    it("retries a request that got no answer after 20 s", () => {
      const t = seeding({ reqPending: true, reqCount: 1, reqSlot: ASSIGNED + 21 * SECS });
      expect(kind(input({ table: t, slot: ASSIGNED + 21 * SECS + SEED_RETRY_SLOTS, stalledMs: LATE }))).toBe("requestSeed");
    });
    it("stops after three requests", () => {
      const t = seeding({ reqPending: true, reqCount: 3, reqSlot: ASSIGNED + 21 * SECS });
      expect(kind(input({ table: t, slot: ASSIGNED + 50 * SECS, stalledMs: LATE }))).toBe("wait");
    });
  });

  describe("start", () => {
    const ready = { table: seeding({ seedReady: true }) };
    it("waits for the keeper", () => expect(nextStep(input(ready))).toEqual({ kind: "wait", why: "seed" }));
    it("starts the clock when stalled", () => expect(kind(input({ ...ready, stalledMs: LATE }))).toBe("start"));
  });

  it("counts down to the start slot", () => {
    expect(nextStep(input({ table: running(), slot: START - 3 * SECS }))).toEqual({ kind: "wait", why: "clock" });
  });

  describe("begin", () => {
    it("begins at the start slot, at once", () => expect(kind(input({ table: running(), slot: START, board: fixtureBoard() }))).toBe("begin"));
    it("waits for the Board to be readable", () => expect(nextStep(input({ table: running(), slot: START, board: null }))).toEqual({ kind: "wait", why: "setup" }));
    it("is the submitter's from then on", () => expect(kind(input({ table: running(), slot: START + 30 * SECS, board: fixtureBoard({ began: true }) }))).toBe("run"));
    it("a Player who reloaded mid-run resumes: began on chain means run", () => expect(kind(input({ table: running(), slot: START + 70 * SECS, board: fixtureBoard({ began: true, moves: 12 }) }))).toBe("run"));
    it("keeps running through the freeze and the grace", () => {
      expect(kind(input({ table: running(), slot: START + 85 * SECS, board: fixtureBoard({ began: true }) }))).toBe("run");
      expect(kind(input({ table: running(), slot: START + 92 * SECS, board: fixtureBoard({ began: true }) }))).toBe("run");
    });
  });

  describe("close", () => {
    const over = { table: running(), slot: START + 94 * SECS, board: fixtureBoard({ began: true }) };
    it("waits for the keeper", () => expect(nextStep(input(over))).toEqual({ kind: "wait", why: "result" }));
    it("closes the table when stalled (keeper down)", () => expect(kind(input({ ...over, stalledMs: LATE }))).toBe("close"));
  });

  describe("commit_table", () => {
    const closed = { table: running({ phase: TABLE_PHASE.closed, dirty: true, reason: REASON.played }), slot: START + 100 * SECS };
    it("waits for the keeper", () => expect(nextStep(input(closed))).toEqual({ kind: "wait", why: "result" }));
    it("commits when stalled (keeper down)", () => expect(kind(input({ ...closed, stalledMs: LATE }))).toBe("commitTable"));
  });

  describe("finalize", () => {
    const committed = blankTable({ phase: TABLE_PHASE.closed, dirty: false, ring: [{ state: SLOT.done, tesoroMatch: blankTable().tesoroMatch, epoch: 4, outcome: 1, at: 1 }], logs: [] });
    const closed = { table: running({ phase: TABLE_PHASE.closed, dirty: false }), slot: START + 100 * SECS };
    it("waits while base has no result", () => expect(nextStep(input({ ...closed, stalledMs: LATE }))).toEqual({ kind: "wait", why: "payout" }));
    it("waits for the keeper once base has it", () => expect(nextStep(input({ ...closed, baseTable: committed }))).toEqual({ kind: "wait", why: "payout" }));
    it("finalizes when stalled (keeper down)", () => expect(kind(input({ ...closed, baseTable: committed, stalledMs: LATE }))).toBe("finalize"));
    it("finalizes after the table moved on to its next Match", () => {
      const moved = blankTable({ epoch: 5, phase: TABLE_PHASE.idle });
      expect(kind(input({ table: moved, baseTable: committed, stalledMs: LATE }))).toBe("finalize");
      expect(nextStep(input({ table: moved, baseTable: null, stalledMs: LATE }))).toEqual({ kind: "wait", why: "payout" });
    });
  });

  it("the opener steps in later than the joiner, so the two pages do not send the same step", () => {
    expect(steppedIn({ seat: 1, stalledMs: STEP_IN_MS })).toBe(true);
    expect(steppedIn({ seat: 0, stalledMs: STEP_IN_MS })).toBe(false);
    expect(steppedIn({ seat: 0, stalledMs: LATE })).toBe(true);
  });
});
