import { describe, expect, it } from "vitest";
import { SPLIT } from "./chain";
import { bestHand, compareHands, resultSummary } from "./reading";

const card = (s: string) => "cdhs".indexOf(s[1]) * 13 + "23456789TJQKA".indexOf(s[0]);
const hand = (s: string) => (s ? s.split(" ").map(card) : []);
const read = (hole: string, board = "") => bestHand(hand(hole) as [number, number], hand(board));
const ids = (s: string) => hand(s).sort((a, b) => a - b);
const five = (h: { cards: number[] }) => [...h.cards].sort((a, b) => a - b);

describe("bestHand names and cards", () => {
  it("names every category in plain words and returns the five cards that make it", () => {
    const high = read("As 9d", "7c 5h 3s 2d Kc");
    expect(high.name).toBe("Ace high");
    expect(five(high)).toEqual(ids("As Kc 9d 7c 5h"));

    const pair = read("Ks Kd", "7c 5h 3s 9d Ac");
    expect(pair.name).toBe("Pair of Kings");
    expect(five(pair)).toEqual(ids("Ks Kd Ac 9d 7c"));

    const two = read("As 7d", "Ac 7h 3s 9d 2c");
    expect(two.name).toBe("Two pair, Aces and Sevens");
    expect(five(two)).toEqual(ids("As Ac 7d 7h 9d"));

    const trips = read("9s 9d", "9c 5h 3s Kd 2c");
    expect(trips.name).toBe("Three of a kind, Nines");

    const straight = read("5s 6d", "7c 8h 9s Kd 2c");
    expect(straight.name).toBe("Straight, Nine high");
    expect(five(straight)).toEqual(ids("5s 6d 7c 8h 9s"));

    const wheel = read("As 2d", "3c 4h 5s Kd 9c");
    expect(wheel.name).toBe("Straight, Five high");

    const flush = read("As 9s", "7s 5s 3s Kd 2c");
    expect(flush.name).toBe("Flush, Ace high");
    expect(five(flush)).toEqual(ids("As 9s 7s 5s 3s"));

    const full = read("Ks Kd", "Kc 2h 2s 9d 7c");
    expect(full.name).toBe("Full house, Kings over Twos");

    const quads = read("7s 7d", "7c 7h 2s 9d Ac");
    expect(quads.name).toBe("Four of a kind, Sevens");
    expect(five(quads)).toEqual(ids("7s 7d 7c 7h Ac"));

    const sf = read("5s 6s", "7s 8s 9s Kd 2c");
    expect(sf.name).toBe("Straight flush, Nine high");
    expect(read("As Ks", "Qs Js Ts 2d 3c").name).toBe("Royal flush");
  });

  it("picks the best five out of seven, with six pairs of kings sixes", () => {
    const h = read("Ks Kd", "6c 6h 6s Qd 2c");
    expect(h.name).toBe("Full house, Sixes over Kings");
  });
});

describe("bestHand with fewer than five cards", () => {
  it("names a pocket pair, a high card and a made pair on the Flop's first card", () => {
    expect(read("Qs Qd").name).toBe("Pair of Queens");
    expect(five(read("Qs Qd"))).toEqual(ids("Qs Qd"));
    expect(read("Qs 4d").name).toBe("Queen high");
    expect(five(read("Qs 4d"))).toEqual(ids("Qs"));
    expect(read("Qs 4d", "4c").name).toBe("Pair of Fours");
    expect(read("Qs 4d", "4c 4h").name).toBe("Three of a kind, Fours");
    expect(read("Qs Qd", "4c 4h").name).toBe("Two pair, Queens and Fours");
  });

  it("ignores empty board slots", () => {
    expect(bestHand([card("As"), card("Kd")], [255, 255, 255, 255, 255]).name).toBe("Ace high");
  });
});

describe("compareHands", () => {
  it("says why a hand wins", () => {
    const flush = read("As 9s", "7s 5s 3s Kd 2c");
    const two = read("Kc Kh", "7d 5h 3d Ad 7h");
    expect(compareHands(flush, two)).toEqual({ result: 1, text: "Flush beats Two pair" });
    expect(compareHands(two, flush)).toEqual({ result: -1, text: "Flush beats Two pair" });
  });

  it("compares inside a category by name, then by kicker, and calls ties", () => {
    const kings = read("Ks Kd", "7c 5h 3s 9d Ac");
    const nines = read("9s 9h", "7c 5h 3s 2d Ac");
    expect(compareHands(kings, nines).text).toBe("Pair of Kings beats Pair of Nines");
    const a = read("As Kd", "Kc 5h 3s 9d 2c");
    const b = read("Qs Kh", "Kc 5h 3s 9d 2c");
    expect(compareHands(a, b)).toEqual({ result: 1, text: "Pair of Kings wins on the kicker" });
    const t1 = read("2s 3d", "As Ks Qh Jd 9c");
    const t2 = read("2h 3c", "As Ks Qh Jd 9c");
    expect(compareHands(t1, t2)).toEqual({ result: 0, text: "Both have Ace high" });
  });
});

describe("resultSummary", () => {
  const flush = read("As 9s", "7s 5s 3s Kd 2c");
  const two = read("Kc Kh", "7d 5h 3d Ad 7h");
  it("says who won and why after a showdown", () => {
    const lh = { result: 0, pot: 1200n, showdown: true };
    expect(resultSummary(lh, 0, [flush, two])).toEqual({ outcome: "win", title: "You win 1,200 Chips", detail: "Flush beats Two pair" });
    expect(resultSummary({ ...lh, result: 1 }, 0, [two, flush])).toEqual({ outcome: "lose", title: "Opponent wins 1,200 Chips", detail: "Flush beats Two pair" });
  });
  it("says who folded", () => {
    expect(resultSummary({ result: 0, pot: 300n, showdown: false }, 0, null)).toEqual({ outcome: "win", title: "You win 300 Chips", detail: "Opponent folded" });
    expect(resultSummary({ result: 1, pot: 300n, showdown: false }, 0, null)).toEqual({ outcome: "lose", title: "Opponent wins 300 Chips", detail: "You folded" });
  });
  it("describes a split pot with both hands", () => {
    const a = read("2s 3d", "As Ks Qh Jd Th");
    const b = read("2h 3c", "As Ks Qh Jd Th");
    expect(resultSummary({ result: SPLIT, pot: 3000n, showdown: true }, 0, [a, b])).toEqual({ outcome: "split", title: "Split pot", detail: "Both have Straight, Ace high · 1,500 Chips each" });
  });
});
