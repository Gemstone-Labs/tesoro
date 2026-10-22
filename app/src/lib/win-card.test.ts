import { describe, expect, it } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import { parseWinKey, winCardData, winCardFromRow, winningSeat, winShareText } from "./win-card";

const A = "AaaaPlayer11111111111111111111111111111111";
const B = "BbbbPlayer22222222222222222222222222222222";
const side = (player: string, over: object = {}) => ({ player, funder: player, shareBps: 0, ...over });
const match = (over: Partial<ChainMatch> = {}): ChainMatch =>
  ({
    id: `${A}-7`,
    game: "block-puzzle",
    status: "settled",
    entry: 1000,
    sides: [side(A), side(B)],
    fees: { platformBps: 500, studioBps: 500, leaderboardBps: 100 },
    winner: null,
    session: { settled: true, joined: true, result: "opener", scores: [10, 5], seed: 0n, openerDeadline: 0, deadline: 0 },
    ...over,
  }) as ChainMatch;

describe("parseWinKey", () => {
  it("takes `<opener>-<n>` keys only", () => {
    const opener = "9A69cBNqH3w2YqW1ZxKtRrQmLyV8bDfE4cNhUjSgPoTa";
    expect(parseWinKey(`${opener}-7`)).toEqual({ opener, n: 7n });
    for (const bad of ["14335668317537", "0", "-1", "abc", "", `${opener}-01`, `${opener}-`]) expect(parseWinKey(bad)).toBeNull();
  });
});

describe("winCardFromRow", () => {
  it("shows the history's winner with their Profile and the Gemas they gained", () => {
    const row = { id: "o-7", game: "holdem", entry: 1000, winner: A, gemas: 780 };
    expect(winCardFromRow(row, { name: "Ana", avatar: { kind: "animal", index: 2 } })).toMatchObject({ id: "o-7", game: "holdem", entry: 1000, gemas: 780, name: "Ana", avatar: 3 });
    expect(winCardFromRow(row, null)?.name).toContain("…");
  });
  it("is null for a Game this app does not play", () => {
    expect(winCardFromRow({ id: "o-7", game: "chess", entry: 1, winner: A, gemas: 1 }, null)).toBeNull();
  });
});

describe("winningSeat", () => {
  it("is the winner of a settled Match", () => {
    expect(winningSeat(match())).toBe(0);
    expect(winningSeat(match({ session: { settled: true, joined: true, result: "joiner", scores: [1, 2], seed: 0n, openerDeadline: 0, deadline: 0 } }))).toBe(1);
    expect(winningSeat(match({ game: "holdem", session: null, winner: "joiner" }))).toBe(1);
  });
  it("is null for every Match without a winner", () => {
    expect(winningSeat(match({ status: "open" }))).toBeNull();
    expect(winningSeat(match({ status: "active" }))).toBeNull();
    expect(winningSeat(match({ status: "refunded" }))).toBeNull();
    expect(winningSeat(match({ session: { settled: true, joined: true, result: "draw", scores: [1, 1], seed: 0n, openerDeadline: 0, deadline: 0 } }))).toBeNull();
    expect(winningSeat(match({ session: { settled: false, joined: true, result: "opener", scores: [1, 0], seed: 0n, openerDeadline: 0, deadline: 0 } }))).toBeNull();
    expect(winningSeat(match({ game: "holdem", session: null, winner: null }))).toBeNull();
  });
});

describe("winCardData", () => {
  it("shows the winner's Profile and the Gemas won net of Fees", () => {
    const w = winCardData(match(), { name: "Ana", avatar: { kind: "animal", index: 2 } });
    expect(w).toMatchObject({ id: `${A}-7`, game: "block-puzzle", entry: 1000, gemas: 780, name: "Ana", avatar: 3, hex: "#F08A1C" });
  });
  it("falls back to the short key and a key-derived avatar", () => {
    const w = winCardData(match(), null)!;
    expect(w.name).toContain("…");
    expect(w.avatar).toBeGreaterThanOrEqual(1);
    expect(w.avatar).toBeLessThanOrEqual(12);
  });
  it("is null when nobody won", () => {
    expect(winCardData(match({ status: "refunded" }), null)).toBeNull();
  });
  it("counts only the share of a backed winner", () => {
    const backed = match({ sides: [side(A, { funder: B, shareBps: 5000 }), side(B)] });
    expect(winCardData(backed, null)!.gemas).toBeGreaterThan(0);
    expect(winCardData(backed, null)!.gemas).toBeLessThan(780);
  });
});

describe("winShareText", () => {
  it("names the Game and the Gemas", () => {
    expect(winShareText({ game: "holdem", gemas: 1890, entry: 1000 })).toBe("I just won 1,890 Gemas in a Buckshot Hold'em Match on Tesoro. Play now, your yield pays later.");
  });
});
