import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import real from "./match-pages/block-burst-devnet-2026-10-27.json";
import { backerDelta, matchDelta, matchFee } from "./ledger";
import { chainMatchFromPage } from "./read";
import type { MatchPage } from "@/server/history/reads";

const won = real["won-lost"] as unknown as MatchPage;
const refunded = real.refunded as unknown as MatchPage;
const WINNER = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const LOSER = "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU";
const as = (page: MatchPage, who: string) => chainMatchFromPage(page, new PublicKey(who))!;

describe("a closed Match shows what the chain settled, from the history row", () => {
  it("the winner of a real devnet Match gained 440 and paid a Fee of 60 (not +500 / Fee 0)", () => {
    const m = as(won, WINNER);
    expect(matchDelta(m)).toBe(440);
    expect(matchFee(m)).toBe(60);
    expect(m.settled?.points).toBe(5);
  });
  it("the loser lost the entry, paid no extra, and earned 0 points; the Fee is still the Match's", () => {
    const m = as(won, LOSER);
    expect(matchDelta(m)).toBe(-500);
    expect(matchFee(m)).toBe(60);
    expect(m.settled?.points).toBe(0);
  });
  it("a refund moves nothing and charges nothing", () => {
    const m = as(refunded, WINNER);
    expect(matchDelta(m)).toBe(0);
    expect(matchFee(m)).toBe(0);
    expect(m.settled?.points).toBe(0);
  });
  it("a draw returns both entries: no change, no Fee, no points", () => {
    const draw = { ...won, winner: null, loser: null, winnerSide: null, kind: 2, points: null, fees: { studio: 0, platform: 0, leaderboard: 0 }, parties: won.parties.map((p) => ({ ...p, delta: 0, result: "draw" })) } as MatchPage;
    const m = as(draw, WINNER);
    expect(matchDelta(m)).toBe(0);
    expect(matchFee(m)).toBe(0);
  });
  it("a Backer reads their own party's delta", () => {
    const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const page = { ...won, sides: [won.sides[0], { player: WINNER, funder: BACKER }], parties: [...won.parties, { role: "backer", side: 1, delta: -123, result: "lost", account: BACKER, shareBps: 4000, backingOther: WINNER }] } as unknown as MatchPage;
    const m = as(page, BACKER);
    expect(backerDelta({ ...m, backerSeat: 1, shareBps: 0 } as never)).toBe(-123);
  });
});
