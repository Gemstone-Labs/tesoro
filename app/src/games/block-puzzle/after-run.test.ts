import { describe, expect, it } from "vitest";
import { afterRunLine } from "./burst-copy";

describe("afterRunLine: the busy line under Time's up (ticket 65)", () => {
  // 2026-11-09, 6qPL…-8: the card said "Waiting for the clock…" with no spinner from the end of the run until the result, a while.
  it("says the opponent still has time when this Player ran out of pieces early", () => {
    expect(afterRunLine({ phase: "running", tableClosed: false, commit: null })).toMatch(/opponent still has time/i);
    expect(afterRunLine({ phase: "frozen", tableClosed: false, commit: null })).toMatch(/opponent still has time/i);
  });
  it("adds up the scores while the last moves land", () => {
    expect(afterRunLine({ phase: "grace", tableClosed: false, commit: null })).toBe("Time’s up. Adding up both scores…");
    expect(afterRunLine({ phase: "ended", tableClosed: false, commit: null })).toBe("Time’s up. Adding up both scores…");
  });
  it("saves the result once the table has closed, and says when it is slow", () => {
    expect(afterRunLine({ phase: "closed", tableClosed: true, commit: { phase: "sending", won: false } })).toBe("Saving the result…");
    expect(afterRunLine({ phase: "closed", tableClosed: true, commit: { phase: "slow", won: false } })).toMatch(/You can leave this page/);
  });
  it("pays out the Pot once the result is saved", () => {
    expect(afterRunLine({ phase: "closed", tableClosed: true, commit: null })).toBe("Paying out the Pot…");
  });
  it("never names the plumbing", () => {
    for (const phase of ["running", "frozen", "grace", "ended", "closed"] as const)
      for (const commit of [null, { phase: "sending" as const, won: false }, { phase: "slow" as const, won: true }])
        expect(afterRunLine({ phase, tableClosed: phase === "closed", commit })).not.toMatch(/clock|commit|rollup|chain|keeper|table/i);
  });
});
