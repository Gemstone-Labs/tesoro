import { describe, expect, it } from "vitest";
import { OUTCOME, SLOT, type RunLog, type Slot } from "@/games/block-puzzle/live-chain";
import { blankTable, fixtureKey } from "@/games/block-puzzle/live-fixtures";
import { sessionFromLog, sessionFromTable } from "./burst-read";

const log = (over: Partial<RunLog> = {}): RunLog => ({ engineVersion: 1, seed: 77n, seedHash: new Uint8Array(32), startSlot: 1, reason: 1, scores: [212, 187], counts: [24, 21], moves: new Uint8Array(0), offsets: new Uint8Array(0), ...over });
const slot = (outcome: number): Slot => ({ state: SLOT.done, tesoroMatch: fixtureKey(1), epoch: 4, outcome, at: 1 });

describe("a finished Match's result from the table", () => {
  it("seat 0 (the opener) winning is the opener, with both scores and the Seed", () => {
    expect(sessionFromLog(slot(OUTCOME.win0), log())).toEqual({ settled: true, result: "opener", scores: [212, 187], seed: 77n });
  });
  it("seat 1 winning is the joiner; a draw is a draw", () => {
    expect(sessionFromLog(slot(OUTCOME.win1), log())?.result).toBe("joiner");
    expect(sessionFromLog(slot(OUTCOME.draw), log())?.result).toBe("draw");
  });
  it("a refund (no-show, nobody played) has no scores to show", () => {
    expect(sessionFromLog(slot(OUTCOME.noShow), log())).toBeNull();
    expect(sessionFromLog(slot(OUTCOME.none), log())).toBeNull();
  });
  it("nothing once the ring slot is gone", () => {
    expect(sessionFromLog(null, null)).toBeNull();
    expect(sessionFromTable(null, fixtureKey(1), 4)).toBeNull();
    expect(sessionFromTable(blankTable(), fixtureKey(1), 4)).toBeNull();
  });
  it("finds the Match's slot and log in the committed table", () => {
    const t = blankTable({ ring: [slot(OUTCOME.win1)], logs: [log({ scores: [10, 20] })] });
    expect(sessionFromTable(t, fixtureKey(1), 4)).toMatchObject({ result: "joiner", scores: [10, 20] });
    expect(sessionFromTable(t, fixtureKey(1), 5)).toBeNull();
  });
});
