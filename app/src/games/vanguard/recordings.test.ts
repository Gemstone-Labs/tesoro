import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDINGS_PATH, apply, buildRecordings, constants, expectOf, serialize, startOf, type Recording } from "./recordings";
import { REFUSALS } from "./rules";

const FILE = resolve(import.meta.dirname, "../../../../", RECORDINGS_PATH);

function load(): { constants: ReturnType<typeof constants>; recordings: { meta: Omit<Recording, "actions">; actions: Recording["actions"] }[] } {
  return JSON.parse(readFileSync(FILE, "utf8"));
}

describe("shared recordings", () => {
  it("the checked-in file is what the generator writes now", () => {
    const text = serialize(buildRecordings());
    if (process.env.WRITE_RECORDINGS === "1") writeFileSync(FILE, text);
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, "utf8") === text).toBe(true);
  });

  it("the constants match the ones the Rust engine pins", () => {
    expect(load().constants).toEqual(JSON.parse(JSON.stringify(constants())));
  });

  it("the engine replays every recorded action to the recorded board, events and refusals", () => {
    for (const { meta, actions } of load().recordings) {
      let g = startOf({ ...meta, actions });
      actions.forEach((a, i) => {
        const res = apply(g, a);
        expect(JSON.parse(JSON.stringify(expectOf(res))), `${meta.name} #${i}`).toEqual(a.expect);
        if (res.ok) g = res.game;
      });
    }
  });

  it("covers every outcome, refusal, end reason and special case the Rust engine must reproduce", () => {
    const seen = { outcomes: new Set<string>(), refusals: new Set<string>(), ends: new Set<string>(), capWinners: new Set<string>(), raids: new Set<string>(), spotted: 0, stormShifts: 0, tags: new Set<string>() };
    for (const { meta, actions } of load().recordings) {
      for (const t of meta.tags) seen.tags.add(t);
      for (const a of actions) {
        if (!a.expect.ok) seen.refusals.add(a.expect.reason);
        else
          for (const e of a.expect.events) {
            if (e.kind === "attack") seen.outcomes.add(e.outcome);
            if (e.kind === "end") {
              seen.ends.add(e.reason);
              if (e.reason === "cap") seen.capWinners.add(e.winner);
            }
            if (e.kind === "raid") seen.raids.add(e.army);
            if (e.kind === "spotted") seen.spotted++;
            if (e.kind === "storm") seen.stormShifts += e.shifts.length;
          }
      }
    }
    expect([...seen.outcomes].sort()).toEqual(["defuse", "lose", "mine", "tie", "truck", "win"]);
    expect([...seen.refusals].sort()).toEqual([...REFUSALS].sort());
    expect([...seen.ends].sort()).toEqual(["cap", "stuck", "timeouts", "truck"]);
    expect([...seen.capWinners].sort()).toEqual(["draw", "it", "us"]);
    expect([...seen.raids].sort()).toEqual(["it", "us"]);
    expect(seen.spotted).toBeGreaterThan(0);
    expect(seen.stormShifts).toBeGreaterThan(0);
    for (const t of ["storm-stay", "storm-move", "storm-stuck", "storm-cap-stuck", "two-step-same-piece", "two-step-two-pieces", "recon-run", "cap-edge", "deadline", "grace"]) expect(seen.tags.has(t), t).toBe(true);
  });
});
