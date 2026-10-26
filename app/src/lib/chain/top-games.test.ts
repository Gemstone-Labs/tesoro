import { describe, expect, it } from "vitest";
import { topGames, type PlayedRow } from "./player-account";
import type { GameId } from "../mock/types";

let n = 0;
const row = (game: GameId, result: PlayedRow["result"], at: number): PlayedRow =>
  ({ id: `m${n++}`, game, entry: 500, role: "player", result, delta: 0, backing: null, scores: null, opp: null, at, asset: null, backerDelta: null });

describe("topGames", () => {
  const rows = [
    ...[1, 2, 3, 4].map((i) => row("block-puzzle", i % 2 ? "won" : "lost", i)),
    ...[10, 11, 12].map((t) => row("holdem", "won", t)),
    row("trading-duel", "lost", 50),
    row("vanguard", "won", 20),
  ];

  it("lists at most three games, the most played first", () => {
    const top = topGames(rows);
    expect(top).toHaveLength(3);
    expect(top.map((g) => g.game)).toEqual(["block-puzzle", "holdem", "trading-duel"]);
    expect(top[0]).toEqual({ game: "block-puzzle", matches: 4, wins: 2 });
  });
  it("breaks a tie by the most recent Match", () => {
    expect(topGames(rows).at(-1)?.game).toBe("trading-duel");
  });
  it("counts only Matches with a winner", () => {
    expect(topGames([row("holdem", "refunded", 1), row("holdem", "draw", 2)])).toEqual([]);
  });
});
