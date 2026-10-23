import { describe, expect, it } from "vitest";
import { ASSIGNED, SECS, blankTable } from "./live-fixtures";
import { REASON, TABLE_PHASE } from "./live-chain";
import { stripLine, stripOf, type StripInput } from "./opponent";

const START = ASSIGNED + 70 * SECS;
const running = blankTable({ phase: TABLE_PHASE.getReady, seatsOpen: true, checkedIn: [true, true], seedReady: true, startSlot: START, shownScore: [120, 104], shownMoves: [11, 1] });
const at = (over: Partial<StripInput> = {}): StripInput => ({ table: running, assigned: true, slot: START + 20 * SECS, seat: 0, ownOver: false, ...over });

describe("the opponent strip", () => {
  it("says Waiting for a table until there is an Assignment or a table to read", () => {
    expect(stripOf(at({ assigned: false }))).toEqual({ kind: "table" });
    expect(stripOf(at({ table: null }))).toEqual({ kind: "table" });
    expect(stripLine({ kind: "table" })).toBe("Waiting for a table");
  });

  it("during check-in says whether they are here", () => {
    const t = blankTable({ phase: TABLE_PHASE.assigned, seatsOpen: true, checkedIn: [true, false] });
    expect(stripOf(at({ table: t, slot: ASSIGNED + 10 * SECS }))).toEqual({ kind: "checkIn", theyAreIn: false });
    expect(stripOf(at({ table: t, slot: ASSIGNED + 10 * SECS, seat: 1 }))).toEqual({ kind: "checkIn", theyAreIn: true });
    expect(stripLine({ kind: "checkIn", theyAreIn: false })).toBe("Waiting for your opponent to check in");
  });

  it("deals, then gets ready", () => {
    const seeding = blankTable({ phase: TABLE_PHASE.seeding, checkedIn: [true, true], seedingSlot: ASSIGNED + 10 * SECS });
    expect(stripOf(at({ table: seeding, slot: ASSIGNED + 20 * SECS })).kind).toBe("seed");
    expect(stripOf(at({ slot: START - 3 * SECS })).kind).toBe("getReady");
  });

  it("shows their last public score and moves while they play", () => {
    expect(stripOf(at())).toEqual({ kind: "live", score: 104, moves: 1 });
    expect(stripLine({ kind: "live", score: 1204, moves: 1 })).toBe("1,204 · 1 move");
    expect(stripLine({ kind: "live", score: 9, moves: 3 })).toBe("9 · 3 moves");
  });

  it("shows the seat's own opponent, whichever seat you sit in", () => {
    expect(stripOf(at({ seat: 1 }))).toEqual({ kind: "live", score: 120, moves: 11 });
  });

  it("shows ? from 80 s and through the grace", () => {
    expect(stripOf(at({ slot: START + 79 * SECS })).kind).toBe("live");
    expect(stripOf(at({ slot: START + 80 * SECS })).kind).toBe("hidden");
    expect(stripOf(at({ slot: START + 92 * SECS })).kind).toBe("hidden");
    expect(stripLine({ kind: "hidden" })).toBe("?");
  });

  it("says Waiting for the clock once your own run is over", () => {
    expect(stripOf(at({ ownOver: true })).kind).toBe("clock");
    expect(stripLine({ kind: "clock" })).toBe("Waiting for the clock");
  });

  it("an opponent who never checked in is gone", () => {
    const t = blankTable({ phase: TABLE_PHASE.assigned, seatsOpen: true, checkedIn: [true, false] });
    expect(stripOf(at({ table: t, slot: ASSIGNED + 61 * SECS })).kind).toBe("gone");
    const closed = blankTable({ phase: TABLE_PHASE.closed, checkedIn: [true, false], reason: REASON.absent });
    expect(stripOf(at({ table: closed })).kind).toBe("gone");
    expect(stripLine({ kind: "gone" })).toBe("Your opponent didn’t show up");
  });

  it("shows the final scores once the table is closed", () => {
    const closed = blankTable({ phase: TABLE_PHASE.closed, checkedIn: [true, true], reason: REASON.played, finalScores: [212, 187], finalMoves: [24, 21] });
    expect(stripOf(at({ table: closed }))).toEqual({ kind: "final", score: 187, moves: 21 });
  });
});
