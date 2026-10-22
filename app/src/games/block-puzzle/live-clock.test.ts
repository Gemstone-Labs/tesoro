import { describe, expect, it } from "vitest";
import { ASSIGNED, SECS, blankTable } from "./live-fixtures";
import { TABLE_PHASE, phaseAt } from "./live-chain";
import { CLOCK_TOLERANCE_SLOTS, getReadySecs, mergeClock, runRemainingMs, sampleClock, slotNow } from "./live-clock";

const START = ASSIGNED + 70 * SECS;
const table = blankTable({ phase: TABLE_PHASE.getReady, startSlot: START });

describe("the slot clock", () => {
  it("runs forward from the last read at 100 slots a second", () => {
    const c = sampleClock(1_000, 5_000);
    expect(slotNow(c, 5_000)).toBe(1_000);
    expect(slotNow(c, 6_000)).toBe(1_100);
    expect(slotNow(c, 4_000)).toBe(1_000);
  });

  it("a frozen clock does not move", () => expect(slotNow({ slot: 7, at: 0, rate: 0 }, 99_999)).toBe(7));

  it("counts down to the start slot, rounded up, and not with the page's wall clock", () => {
    const c = sampleClock(START - 7 * SECS, 0);
    expect(getReadySecs(table, c, 0)).toBe(7);
    expect(getReadySecs(table, c, 2_500)).toBe(5);
    expect(getReadySecs(table, c, 7_000)).toBe(0);
    expect(getReadySecs(blankTable(), c, 0)).toBeNull();
  });

  it("the run's 90 s are measured from the start slot", () => {
    expect(runRemainingMs(table, sampleClock(START, 0), 0)).toBe(90_000);
    expect(runRemainingMs(table, sampleClock(START + 30 * SECS, 0), 0)).toBe(60_000);
    expect(runRemainingMs(table, sampleClock(START + 30 * SECS, 0), 10_000)).toBe(50_000);
    expect(runRemainingMs(table, sampleClock(START + 200 * SECS, 0), 0)).toBe(0);
    expect(runRemainingMs(blankTable(), sampleClock(START, 0), 0)).toBe(0);
  });

  it("a join that starts later is on the same clock: a late reader sees the time left, not 90 s", () => {
    const lateReader = sampleClock(START + 45 * SECS, 1_000);
    expect(runRemainingMs(table, lateReader, 1_000)).toBe(45_000);
  });

  it("phases follow the slot: get ready, running, frozen from 80 s, grace to 93 s, ended after", () => {
    expect(phaseAt(table, START - 1)).toBe("getReady");
    expect(phaseAt(table, START)).toBe("running");
    expect(phaseAt(table, START + 79 * SECS)).toBe("running");
    expect(phaseAt(table, START + 80 * SECS)).toBe("frozen");
    expect(phaseAt(table, START + 90 * SECS)).toBe("grace");
    expect(phaseAt(table, START + 93 * SECS)).toBe("grace");
    expect(phaseAt(table, START + 93 * SECS + 1)).toBe("ended");
  });

  describe("mergeClock", () => {
    const prev = sampleClock(1_000, 0);
    it("keeps the running clock when a read agrees with it, so the timer never jitters", () => {
      const read = sampleClock(1_000 + 100 + CLOCK_TOLERANCE_SLOTS - 1, 1_000);
      expect(mergeClock(prev, read)).toBe(prev);
    });
    it("takes the read when it is far off (a stall, a reconnect)", () => {
      const read = sampleClock(1_000 + 100 + CLOCK_TOLERANCE_SLOTS + 1, 1_000);
      expect(mergeClock(prev, read)).toBe(read);
    });
    it("takes the first read", () => {
      const read = sampleClock(5, 0);
      expect(mergeClock(null, read)).toBe(read);
    });
  });
});
