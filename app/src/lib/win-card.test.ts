import { describe, expect, it } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import { parseMatchId, winCardData, winningSeat, winShareText } from "./win-card";

const A = "AaaaPlayer11111111111111111111111111111111";
const B = "BbbbPlayer22222222222222222222222222222222";
const side = (player: string, over: object = {}) => ({ player, funder: player, shareBps: 0, ...over });
const match = (over: Partial<ChainMatch> = {}): ChainMatch =>
  ({
    id: 7n,
    game: "block-puzzle",
    status: "settled",
    entry: 1000,
    sides: [side(A), side(B)],
    fees: { platformBps: 500, studioBps: 500, leaderboardBps: 100 },
    winner: null,
    session: { settled: true, joined: true, result: "opener", scores: [10, 5], seed: 0n, openerDeadline: 0, deadline: 0 },
    ...over,
  }) as ChainMatch;

describe("parseMatchId", () => {
  it("takes whole u64 numbers only", () => {
    expect(parseMatchId("14335668317537")).toBe(14335668317537n);
    expect(parseMatchId("18446744073709551615")).toBe(18446744073709551615n);
    expect(parseMatchId("18446744073709551616")).toBeNull();
    for (const bad of ["0", "-1", "1.5", "abc", "", "01", "1e3"]) expect(parseMatchId(bad)).toBeNull();
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
    expect(w).toMatchObject({ id: "7", game: "block-puzzle", entry: 1000, gemas: 780, name: "Ana", avatar: 3, hex: "#F08A1C" });
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
    expect(winShareText({ game: "holdem", gemas: 1890, entry: 1000 })).toBe("I just won 1,890 Gemas in a Heads-up Hold'em Match on Tesoro. Play now, your yield pays later.");
  });
});
