import { describe, expect, it } from "vitest";
import type { Battle } from "./decode";
import { claimDue, turnKey } from "./clock";

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
