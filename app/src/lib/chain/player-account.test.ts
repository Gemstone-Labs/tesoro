import { describe, expect, it } from "vitest";
import { backed, match } from "./fixture";
import { backingLine, playedRows, playerSummary, runningTotal, signed } from "./player-account";
import type { ChainMatch } from "./read";

const BACKER_A = "BackerA111111111111111111111111111111111111";
const BACKER_B = "BackerB111111111111111111111111111111111111";

const win = (mins: number, entry = 1000) => match("block-puzzle", entry, true, mins, [120, 80]);
const loss = (mins: number, entry = 1000) => match("block-puzzle", entry, false, mins, [120, 80]);
const draw = (mins: number): ChainMatch => {
  const m = win(mins);
  return { ...m, status: "refunded", session: { ...m.session!, result: "draw" } };
};
const refund = (mins: number): ChainMatch => ({ ...win(mins), status: "refunded", session: null });
/** Settled on tesoro_core, but its Session did not decode: there is no result to show. */
const unread = (mins: number): ChainMatch => ({ ...win(mins), session: null });

describe("playedRows", () => {
  it("carries the Backer's result beside the Player's on a backed Match", () => {
    // Pot 2,000, 5% Fees from the loser's 1,000: surplus 900, Player 40% = 360, Backer 540.
    const [won] = playedRows([backed(win(5), BACKER_A)]);
    expect(won).toMatchObject({ result: "won", delta: 360, backerDelta: 540 });
    expect(backingLine(won)).toBe("Backed by Back…1111 · Backer +540");

    const [lost] = playedRows([backed(loss(5), BACKER_A)]);
    expect(lost).toMatchObject({ result: "lost", delta: 0, backerDelta: -1000 });
    expect(backingLine(lost)).toBe("Backer Back…1111 bore the loss · −1,000");
  });

  it("has no Backer result on an unbacked Match, and 0 on a backed draw", () => {
    const [own] = playedRows([win(5)]);
    expect(own.backerDelta).toBeNull();
    expect(backingLine(own)).toBeNull();
    const [d] = playedRows([backed(draw(5), BACKER_A)]);
    expect(d).toMatchObject({ result: "draw", backerDelta: 0 });
    expect(backingLine(d)).toBe("Backed by Back…1111");
  });

  it("leaves out Matches the Account only funded, unfinished Matches and unreadable ones", () => {
    const funded = backed(win(5), "PlayerKey1111111111111111111111111111111111", 4000, true);
    const active: ChainMatch = { ...win(6), status: "active" };
    expect(playedRows([funded, active, unread(7)])).toEqual([]);
  });
});

describe("playerSummary", () => {
  it("counts only Matches with a winner, and says how many it left out", () => {
    const s = playerSummary([win(1), win(2), loss(3), draw(4), refund(5), unread(6)]);
    expect(s.record).toEqual({ matches: 3, wins: 2 });
    expect(s.undecided).toBe(2);
    expect(s.notRead).toBe(1);
  });

  it("adds up Gemas won and lost after Fees", () => {
    // Each win pays the loser's 1,000 less 5% of the 2,000 Pot.
    const s = playerSummary([win(1), win(2), loss(3, 2500)]);
    expect(s).toMatchObject({ won: 1800, lost: 2500, net: -700 });
  });

  it("keeps the Backers' Gemas beside the Player's: a backed Player never shows a loss", () => {
    const s = playerSummary([backed(win(1), BACKER_A), backed(loss(2), BACKER_A), backed(loss(3), BACKER_B), backed(win(4), BACKER_B, 3000), win(5)]);
    expect(s).toMatchObject({ won: 360 + 270 + 900, lost: 0 });
    expect(s.backings).toEqual({
      matches: 4,
      wins: 2,
      backers: 2,
      // A: +540 −1,000. B: −1,000 +630. Neither is ahead.
      ahead: 0,
      won: 540 + 630,
      lost: 2000,
      net: -830,
    });
  });

  it("counts a Backer as ahead over all their Backings of this Player", () => {
    const s = playerSummary([backed(win(1), BACKER_A), backed(win(2), BACKER_A), backed(loss(3), BACKER_B)]);
    expect(s.backings).toMatchObject({ backers: 2, ahead: 1 });
  });

  it("is all zeros for an Account that has not played", () => {
    const s = playerSummary([]);
    expect(s).toMatchObject({ record: { matches: 0, wins: 0 }, undecided: 0, notRead: 0, net: 0 });
    expect(s.backings.matches).toBe(0);
  });
});

describe("runningTotal", () => {
  it("adds up in the order the Matches were opened, skipping draws and refunds", () => {
    // Opened 40, 30, 20 and 10 minutes ago: loss, draw, win, win.
    const series = runningTotal(playedRows([win(10), win(20), draw(30), loss(40)]));
    expect(series.map((p) => p.total)).toEqual([-1000, -100, 800]);
    expect(series.map((p) => p.row.result)).toEqual(["lost", "won", "won"]);
  });
});

describe("signed", () => {
  it("writes the sign in the text", () => {
    expect([signed(540), signed(-1000), signed(0)]).toEqual(["+540", "−1,000", "0"]);
  });
});
