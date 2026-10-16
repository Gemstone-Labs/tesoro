import { describe, expect, it } from "vitest";
import { playRunLine, unplayedRun } from "./run-status";

const T = 1_000_000;
const m = (over = {}) => ({
  status: "active" as const,
  game: "block-puzzle" as const,
  seat: 1 as 0 | 1 | null,
  deadline: T + 3600,
  session: { settled: false, joined: true, openerDeadline: T + 600, deadline: T + 1200 },
  ...over,
});

describe("unplayedRun", () => {
  it("is the joiner's deadline for an unplayed joiner run", () => {
    expect(unplayedRun(m(), T, "needs-prep")).toEqual({ playBy: T + 1200 });
    expect(unplayedRun(m(), T, "ready")).toEqual({ playBy: T + 1200 });
  });

  it("is the opener's deadline for the opener, even before anyone joined", () => {
    const open = m({ status: "open", seat: 0, session: { settled: false, joined: false, openerDeadline: T + 600, deadline: 0 } });
    expect(unplayedRun(open, T, "ready")).toEqual({ playBy: T + 600 });
  });

  it("uses the core deadline for a joiner whose session join is missing", () => {
    const j = m({ session: { settled: false, joined: false, openerDeadline: T + 600, deadline: 0 } });
    expect(unplayedRun(j, T, "ready")).toEqual({ playBy: T + 3600 });
  });

  it("is null once the run began, finished or committed, or when the stage is unknown", () => {
    for (const s of ["lost-run", "finished", "committed"] as const) expect(unplayedRun(m(), T, s)).toBeNull();
    expect(unplayedRun(m(), T, undefined)).toBeNull();
  });

  it("is null after the window closed, for settled sessions, spectators and other games", () => {
    expect(unplayedRun(m(), T + 1200, "ready")).toBeNull();
    expect(unplayedRun(m({ session: { settled: true, joined: true, openerDeadline: T + 600, deadline: T + 1200 } }), T, "ready")).toBeNull();
    expect(unplayedRun(m({ seat: null }), T, "ready")).toBeNull();
    expect(unplayedRun(m({ game: "holdem", session: null }), T, "ready")).toBeNull();
    expect(unplayedRun(m({ status: "settled" }), T, "ready")).toBeNull();
  });
});

describe("playRunLine", () => {
  it("names the closing time", () => {
    expect(playRunLine({ playBy: T }, T * 1000 - 5000)).toMatch(/^Play your run · closes at /);
  });
});
