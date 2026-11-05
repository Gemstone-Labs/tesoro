import { describe, expect, it } from "vitest";
import type { HistoryRow } from "./history";
import { backerRideLine, rideOfOffer } from "./ride-history";

const BEN = "BenPlayer1111111111111111111111111111111111";
const EVE = "EvePlayer1111111111111111111111111111111111";
const T = 1_762_300_000_000;
const row = (o: Partial<HistoryRow>): HistoryRow => ({ id: "o-1", game: "railcar", entry: 500, role: "backer", result: "won", delta: 78, backing: { other: BEN, shareBps: 4_000 }, scores: null, opp: null, at: T, asset: null, ride: { seated: 5, kind: "place", place: 2, jumpMs: 97_000 }, ...o });

describe("the ride a used Railcar Offer funded", () => {
  it("is the Backer's newest ride for that Player that opened before the Offer's use-by", () => {
    const rows = [row({ id: "o-3", at: T + 900_000 }), row({ id: "o-2", at: T }), row({ id: "o-4", backing: { other: EVE, shareBps: 4_000 } }), row({ id: "o-5", game: "holdem", ride: undefined })];
    expect(rideOfOffer(rows, { player: BEN, useBy: (T + 600_000) / 1000 })?.id).toBe("o-2");
    expect(rideOfOffer(rows, { player: BEN, useBy: (T + 1_000_000) / 1000 })?.id).toBe("o-3");
    expect(rideOfOffer(rows, { player: BEN, useBy: (T - 1) / 1000 })).toBeNull();
    expect(rideOfOffer([row({ role: "player" })], { player: BEN, useBy: T })).toBeNull();
  });
});

describe("the Backer's line of a ride", () => {
  it("a place: the entry comes back first, then the Backer's share of the winnings", () => {
    expect(backerRideLine(row({}))).toBe("Second-last off at 1:37: your 500 back, then +78 of the winnings");
  });
  it("an early Jump returns the refund to the Backer; aboard at Impact the Backer loses the entry; a refund returns it", () => {
    expect(backerRideLine(row({ result: "lost", delta: -150, ride: { seated: 5, kind: "early", jumpMs: 25_000 } }))).toBe("Jumped at 0:25: 350 of your 500 back");
    expect(backerRideLine(row({ result: "lost", delta: -500, ride: { seated: 5, kind: "aboard" } }))).toBe("Aboard at Impact: your 500 is lost");
    expect(backerRideLine(row({ result: "refunded", delta: 0, ride: { seated: 5, kind: "refund" } }))).toBe("Ride refunded: your 500 back");
  });
});
