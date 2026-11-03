import { describe, expect, it } from "vitest";
import { ingestMatchRecords, tableFreer } from "./ingest";
import type { MatchRunStartedRecord } from "./events";

const start = (n: bigint, kind: number): MatchRunStartedRecord => ({
  type: "start", opener: "9A69s3m8ZQdJ4cS8xv9N2dTz1kYbq7R4tHgW5aXe3Lp1", n, game: "11111111111111111111111111111111", kind, winnerSide: kind === 0 ? 0 : null,
  entry: 500, fees: [0, 0, 0], aPlayer: "a", aFunder: "a", bPlayer: "b", bFunder: "b", challenge: false, asset: 0, openedAt: 1, ts: 2, aShareBps: 0, bShareBps: 0,
});

describe("a Match that ended frees its table", () => {
  const run = async (kinds: number[]) => {
    const ended: [string, boolean][] = [];
    await ingestMatchRecords(async () => true, kinds.map((k, i) => start(BigInt(i + 1), k)), { gameOf: (p) => p, onMatchEnded: async (key, ran) => void ended.push([key, ran]) });
    return ended;
  };

  it("names the Match by its key and says whether it ran (a win or a draw)", async () => {
    const ended = await run([0, 2, 1, 3, 4, 6]);
    expect(ended.map(([key]) => key.split("-")[1])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ended.map(([, ran]) => ran)).toEqual([true, true, false, false, false, false]);
  });

  it("is what the pool's free_table takes", async () => {
    const calls: [string, unknown][] = [];
    await tableFreer(async (fn, args) => void calls.push([fn, args]))("opener-7", true);
    expect(calls).toEqual([["free_table", { p_match: "opener-7", p_advanced: true }]]);
  });

  it("does not stop the history when the pool cannot be written", async () => {
    await expect(tableFreer(async () => { throw new Error("function public.free_table does not exist"); })("opener-7", true)).resolves.toBeUndefined();
  });
});
