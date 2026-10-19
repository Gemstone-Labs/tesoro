import { describe, expect, it } from "vitest";
import type { Battle } from "./decode";
import { PRACTICE_COUNTDOWN, START_COUNTDOWN, claimDue, getReadyLeft, missedLabel, ringLeft, ringStart, turnKey } from "./clock";
import { OPENING_GRACE_MS } from "./rules";

const T0 = 1_760_000_000_000;
const base = { status: 2, deadline: 0, startedAt: 1_760_000_000, startDeadline: 1_760_000_300, entropyDeadline: 0, turn: 0, turnNo: 3, moves: 3, stepsLeft: 1, twoStepActive: 0, eventSeq: 5 } as unknown as Battle;

describe("when a client may ask the program to pass a turn", () => {
  it("waits out the 5 second turn, the 1 second grace and a margin, counted from when the turn was first seen", () => {
    expect(claimDue(base, T0, T0 + 5_000)).toBe(false);
    expect(claimDue(base, T0, T0 + 6_000)).toBe(false);
    expect(claimDue(base, T0, T0 + 7_000)).toBe(true);
  });

  it("claims the time cap once 15 minutes have passed since the start", () => {
    const startMs = base.startedAt * 1000;
    // the turn was only just seen, so only the cap can be due
    expect(claimDue(base, startMs + 900_000, startMs + 900_500)).toBe(false);
    expect(claimDue(base, startMs + 899_000, startMs + 902_500)).toBe(true);
  });

  it("claims a Match that never started once its start window has passed", () => {
    const setup = { ...base, status: 1 } as Battle;
    expect(claimDue(setup, T0, base.startDeadline * 1000 + 1_000)).toBe(false);
    expect(claimDue(setup, T0, base.startDeadline * 1000 + 3_000)).toBe(true);
  });

  it("claims a stalled entropy window", () => {
    const setup = { ...base, status: 1, entropyDeadline: base.startedAt + 100 } as Battle;
    expect(claimDue(setup, T0, setup.entropyDeadline * 1000 + 3_000)).toBe(true);
  });

  it("never claims on a Match that is over", () => {
    expect(claimDue({ ...base, status: 3 } as Battle, T0, T0 + 999_999_999)).toBe(false);
  });
});

describe("turnKey", () => {
  it("changes when a turn or a step begins and not when only the clock fields change", () => {
    expect(turnKey(base)).toBe(turnKey({ ...base, deadline: 99 } as Battle));
    expect(turnKey(base)).not.toBe(turnKey({ ...base, moves: 4 } as Battle));
    expect(turnKey(base)).not.toBe(turnKey({ ...base, stepsLeft: 2, twoStepActive: 1 } as Battle));
  });
});

describe("the opening turn", () => {
  const opening = { ...base, turnNo: 0, moves: 0 } as Battle;

  it("has the opening grace before its 5 seconds start, in the ring and in the claim", () => {
    expect(ringStart(base, T0)).toBe(T0);
    expect(ringStart(opening, T0)).toBe(T0 + 10_000);
    expect(claimDue(opening, T0, T0 + 7_000)).toBe(false);
    expect(claimDue(opening, T0, T0 + 16_000)).toBe(false);
    expect(claimDue(opening, T0, T0 + 17_000)).toBe(true);
  });
});

describe("the 5 second ring", () => {
  it("is full when the turn is seen and empty after 5 seconds", () => {
    expect(ringLeft(base, T0, T0)).toBe(1);
    expect(ringLeft(base, T0, T0 + 2_500)).toBe(0.5);
    expect(ringLeft(base, T0, T0 + 5_000)).toBe(0);
    expect(ringLeft(base, T0, T0 + 9_000)).toBe(0);
  });

  it("stays full through the opening grace, then runs the 5 seconds", () => {
    const opening = { ...base, turnNo: 0, moves: 0 } as Battle;
    expect(ringLeft(opening, T0, T0 + 9_000)).toBe(1);
    expect(ringLeft(opening, T0, T0 + 12_500)).toBe(0.5);
  });
});

describe("missed turns", () => {
  it("says nothing until a clock has run out, then counts to three", () => {
    expect([0, 1, 2].map(missedLabel)).toEqual([null, "Missed 1 of 3", "Missed 2 of 3"]);
    expect(missedLabel(3)).toBe("Missed 3 of 3");
  });
});

describe("the get-ready countdown before the first move", () => {
  it("counts 10 real seconds, ticking only on the last 3, as long as the chain's opening grace", () => {
    expect(START_COUNTDOWN).toEqual({ from: 10, stepMs: 1000, tickAt: 3 });
    expect(START_COUNTDOWN.from * START_COUNTDOWN.stepMs).toBe(OPENING_GRACE_MS);
  });

  it("is 6 seconds in Practice, where no chain is loading", () => {
    expect(PRACTICE_COUNTDOWN).toEqual({ from: 6, stepMs: 1000, tickAt: 3 });
  });

  it("shows on a real Match's opening turn with the seconds left, so a reload picks up where it was", () => {
    const opening = { ...base, turnNo: 0, moves: 0 } as Battle;
    expect(getReadyLeft(opening, T0, T0)).toBe(10);
    expect(getReadyLeft(opening, T0, T0 + 3_200)).toBe(7);
    expect(getReadyLeft(opening, T0, T0 + 9_999)).toBe(1);
  });

  it("is gone once the opening grace is over, on later turns, and before the Match is live", () => {
    const opening = { ...base, turnNo: 0, moves: 0 } as Battle;
    expect(getReadyLeft(opening, T0, T0 + 10_000)).toBeNull();
    expect(getReadyLeft(base, T0, T0)).toBeNull();
    expect(getReadyLeft({ ...opening, status: 1 } as Battle, T0, T0)).toBeNull();
  });
});
