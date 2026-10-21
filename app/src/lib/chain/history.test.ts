import { describe, expect, it } from "vitest";
import { match } from "./fixture";
import { accountHistory, amountText, backingText, historyPage, historyRow } from "./history";
import type { ChainMatch } from "./read";

const ME = "Me111111111111111111111111111111111111111111";
const BACKER = "BackerKey1111111111111111111111111111111111";
const PLAYER = "PlayerKey1111111111111111111111111111111111";

/** A settled Block Puzzle Match this Account played from seat 0, backed by BACKER at 40%. */
function backedPlayed(won: boolean): ChainMatch {
  const m = match("block-puzzle", 1000, won, 5, [120, 80]);
  return { ...m, sides: [{ player: ME, funder: BACKER, shareBps: 4000 }, m.sides[1]], backing: { seat: 0, player: ME, funder: BACKER, shareBps: 4000 } };
}

describe("historyRow", () => {
  it("shows a backed Player's loss as a loss of 0 Gemas with the Backer named", () => {
    const r = historyRow(backedPlayed(false));
    expect(r).toMatchObject({ result: "lost", delta: 0, role: "player", backing: { other: BACKER } });
    expect(amountText(r!)).toBe("0 Gemas");
    expect(backingText(r!)).toBe("Backer Back…1111 bore the loss");
  });

  it("an unbacked loss costs the entry", () => {
    const r = historyRow(match("block-puzzle", 1000, false, 5, [120, 80]))!;
    expect(r.result).toBe("lost");
    expect(amountText(r)).toBe("−1,000 Gemas");
    expect(backingText(r)).toBeNull();
  });

  it("a backed win is the Player's share of the surplus", () => {
    const r = historyRow(backedPlayed(true))!;
    // Pot 2,000, 5% Fees from the loser's 1,000: surplus 900, Player 40% = 360.
    expect(r).toMatchObject({ result: "won", delta: 360 });
    expect(backingText(r)).toBe("Backed by Back…1111");
  });

  it("a Match this Account funded is the Backer's split or loss", () => {
    const base = match("block-puzzle", 1000, false, 5, [120, 80]);
    const funded: ChainMatch = {
      ...base,
      seat: null,
      backerSeat: 0,
      sides: [{ player: PLAYER, funder: ME, shareBps: 4000 }, base.sides[1]],
      backing: { seat: 0, player: PLAYER, funder: ME, shareBps: 4000 },
    };
    const r = historyRow(funded)!;
    expect(r).toMatchObject({ role: "backer", result: "lost", delta: -1000, backing: { other: PLAYER } });
    expect(backingText(r)).toBe("You backed Play…1111");
  });

  it("orients scores to this side and skips unfinished Matches", () => {
    const m = match("block-puzzle", 1000, false, 5, [120, 80]);
    expect(historyRow({ ...m, seat: 1 })?.scores).toEqual([120, 80]);
    expect(historyRow({ ...m, status: "active" })).toBeNull();
  });

  it("draws and refunds move nothing", () => {
    const m = match("block-puzzle", 1000, true, 5, [90, 90]);
    const draw = historyRow({ ...m, status: "refunded", session: { ...m.session!, result: "draw" } })!;
    expect(draw).toMatchObject({ result: "draw", delta: 0 });
    const refund = historyRow({ ...m, status: "refunded", session: null })!;
    expect(amountText(refund)).toBe("Entry refunded");
  });
});

describe("accountHistory and paging", () => {
  it("merges played and funded Matches, newest first, across both games", () => {
    const rows = accountHistory([match("holdem", 500, true, 30, [0, 0]), match("block-puzzle", 1000, true, 2, [9, 1])]);
    expect(rows.map((r) => r.game)).toEqual(["block-puzzle", "holdem"]);
  });

  it("pages 10 at a time and clamps the page", () => {
    const rows = Array.from({ length: 45 }, (_, i) => i);
    expect(historyPage(rows, 1)).toMatchObject({ page: 1, pages: 5 });
    expect(historyPage(rows, 5).rows).toEqual([40, 41, 42, 43, 44]);
    expect(historyPage(rows, 9).page).toBe(5);
    expect(historyPage(rows, Number.NaN).page).toBe(1);
    expect(historyPage([], 1)).toEqual({ rows: [], page: 1, pages: 1 });
  });
});

describe("Trading Duel history", () => {
  it("reads the asset and the opening time from the id", () => {
    const m = match("trading-duel", 500, true, 7, [0, 0]);
    const r = historyRow(m)!;
    expect(r).toMatchObject({ game: "trading-duel", result: "won", asset: 1 });
    expect(Math.abs(Date.now() - r.at - 7 * 60_000)).toBeLessThan(5_000);
  });

  it("the game filter accepts Trading Duel", async () => {
    const { gameFilter } = await import("../../components/match/MatchHistory");
    expect(gameFilter("trading-duel")).toBe("trading-duel");
    expect(gameFilter("nonsense")).toBeNull();
  });
});
