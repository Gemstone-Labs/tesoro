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

  it("lets loading and role stages through", () => {
    const p = matchProgress<object, string>("m");
    p.stage("closing");
    expect(p.stage("spectator").held).toBe(false);
  });
});
