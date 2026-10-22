import { describe, expect, it, vi } from "vitest";
import { endStateOf, recordEndState, type EndState } from "./end-state";
import { testDb } from "./test-db";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const duel: EndState = { game: "trading-duel", track: { lo: ["1"], hi: ["2"], seen: [true] }, picks: [[1], [255]], scores: [3, 4], winner: 1 };

describe("end states", () => {
  it("stores a Match's end state once and reads it back", async () => {
    const { rpc } = await testDb();
    expect(await endStateOf(rpc, "MatchA")).toBeNull();
    expect(await recordEndState(rpc, "MatchA", 4, duel)).toBe(true);
    expect(await recordEndState(rpc, "MatchA", 5, { ...duel, scores: [9, 9] })).toBe(false);
    expect(await endStateOf(rpc, "MatchA")).toEqual({ game: "trading-duel", epoch: 4, state: duel });
    expect(await endStateOf(rpc, "MatchB")).toBeNull();
  });
});
