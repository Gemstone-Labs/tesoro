import { describe, expect, it } from "vitest";
import { matchProgress, stageRank } from "./match-progress";
import { CANCELLING_NOTE, NO_TABLE_NOTE } from "./match-status";

describe("matchProgress", () => {
  it("never moves the stage back", () => {
    const p = matchProgress<object, string>("m");
    expect(p.stage("waiting").held).toBe(false);
    expect(p.stage("setup", "Starting the Match").held).toBe(false);
    expect(p.stage("closing", "Saving the result").stage).toBe("closing");
    const back = p.stage("setup", NO_TABLE_NOTE);
    expect(back).toEqual({ stage: "closing", note: "Saving the result", held: true });
    expect(p.stage("table").held).toBe(true);
    expect(p.stage("settled").stage).toBe("settled");
  });

  it("does not let a missing Match replace a stage that was shown", () => {
    const p = matchProgress<object, string>("m");
    p.stage("live");
    expect(p.stage("notfound").stage).toBe("live");
  });

  it("lets notfound show when nothing was shown yet", () => {
    expect(matchProgress<object, string>("m").stage("notfound").stage).toBe("notfound");
  });

  it("treats setup with the no-table note as the table wait", () => {
    expect(stageRank("setup", NO_TABLE_NOTE)).toBe(stageRank("table"));
    expect(stageRank("setup", CANCELLING_NOTE)).toBe(stageRank("table"));
    expect(stageRank("setup", "Joining the Match")).toBeGreaterThan(stageRank("table")!);
  });

  it("keeps the last Match seen when a fresh read finds none", () => {
    const p = matchProgress<{ id: number }, string>("m");
    expect(p.match(null)).toBeNull();
    p.match({ id: 1 });
    expect(p.match(null)).toEqual({ id: 1 });
    expect(p.match({ id: 2 })).toEqual({ id: 2 });
  });

  // The history row of a closed Match arrives after the webhook finalizes it; the page must not wait on it to show a result it already knew.
  it("a Match seen with its result fixed and its run under way is settled when the account is gone and the history knows nothing", () => {
    const p = matchProgress<{ status: string; running: string | null; fixed?: string; winner: string | null }, string>("m");
    p.match({ status: "active", running: "settling", fixed: "settled", winner: "joiner" });
    expect(p.match(null)).toEqual({ status: "settled", running: null, fixed: undefined, winner: "joiner" });
  });

  it("a refunding run that vanishes is refunded", () => {
    const p = matchProgress<{ status: string; running: string | null; fixed?: string; winner: string | null }, string>("m");
    p.match({ status: "active", running: "refunding", fixed: "refunded", winner: null });
    expect(p.match(null)?.status).toBe("refunded");
  });

  it("an active Match without a fixed result is not settled by a missing read", () => {
    const p = matchProgress<{ status: string; running: string | null; fixed?: string }, string>("m");
    p.match({ status: "active", running: null });
    expect(p.match(null)?.status).toBe("active");
  });

  it("keeps a result once seen: an older read of the same Match never replaces it", () => {
    const p = matchProgress<{ status: string; v: number }, string>("m");
    p.match({ status: "open", v: 0 });
    expect(p.match({ status: "refunded", v: 1 })?.v).toBe(1);
    expect(p.match({ status: "open", v: 2 })?.v).toBe(1);
    expect(p.match({ status: "active", v: 3 })?.v).toBe(1);
    expect(p.match(null)?.v).toBe(1);
    expect(p.match({ status: "refunded", v: 4 })?.v).toBe(4);
  });

  it("lets loading and role stages through", () => {
    const p = matchProgress<object, string>("m");
    p.stage("closing");
    expect(p.stage("spectator").held).toBe(false);
  });
});
