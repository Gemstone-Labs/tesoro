import { describe, expect, it } from "vitest";
import type { HistoryRow } from "./history";
import { gameFacts, playAgainRows, playAgainTarget, waitingByEntry } from "./lobby-plays";

const OPP = "7zr1j185mQwYk3G2sP9Zx4Vb6nTdLf8HcRuEaNoXyqh7";
const row = (o: Partial<HistoryRow>): HistoryRow => ({ id: "1", game: "block-puzzle", entry: 500, role: "player", result: "won", delta: 10, backing: null, scores: null, opp: OPP, at: 1, asset: null, ...o });

describe("lobby plays", () => {
  it("keeps the newest Match per game and entry, skips refunds and Backer rows, caps at three", () => {
    const rows = [
      row({ id: "a", at: 1 }),
      row({ id: "b", at: 5 }),
      row({ id: "c", at: 4, result: "refunded", game: "holdem" }),
      row({ id: "d", at: 3, role: "backer", game: "holdem" }),
      row({ id: "e", at: 2, entry: 1000 }),
      row({ id: "f", at: 6, game: "holdem" }),
      row({ id: "g", at: 7, game: "trading-duel", asset: 1 }),
    ];
    expect(playAgainRows(rows).map((r) => r.id)).toEqual(["g", "f", "b"]);
  });

  it("leads to a Challenge with the same opponent, else the Queue at the entry", () => {
    expect(playAgainTarget(row({ game: "holdem", entry: 1000 }))).toEqual({ href: `/play/challenge?game=holdem&entry=1000&opponent=${OPP}`, sameOpponent: true });
    expect(playAgainTarget(row({ opp: null }))).toEqual({ href: "/play/queue?entry=500", sameOpponent: false });
  });

  it("reads last result and best Block Puzzle score per game", () => {
    const f = gameFacts([row({ at: 2, result: "lost", scores: [90, 100] }), row({ at: 1, scores: [140, 80] }), row({ game: "holdem", at: 3, result: "draw" })]);
    expect(f["block-puzzle"]).toEqual({ last: "lost", best: 140 });
    expect(f.holdem).toEqual({ last: "draw", best: null });
    expect(f["trading-duel"]).toBeUndefined();
  });

  it("counts waiting Players per entry without the viewer", () => {
    const seats = [
      { player: "A", entry: 500, asset: 0 },
      { player: "B", entry: 500, asset: 0 },
      { player: "me", entry: 1000, asset: 0 },
    ];
    expect(waitingByEntry(seats, [500, 1000, 2500], "me")).toEqual({ 500: 2, 1000: 0, 2500: 0 });
  });
});
