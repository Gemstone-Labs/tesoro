import { describe, expect, it } from "vitest";
import { NO_CARD, PHASE, SPLIT, STATUS, call, check, fold, raise } from "../chain";
import { legalMoves } from "../rules";
import { botAction, equity } from "./bot";
import { act, deal, newPractice, STARTING_CHIPS, type Practice } from "./engine";
import { FLUSH, FULL_HOUSE, HIGH_CARD, PAIR, QUADS, STRAIGHT, STRAIGHT_FLUSH, TRIPS, TWO_PAIR, category, eval7 } from "./eval";

const card = (s: string) => "cdhs".indexOf(s[1]) * 13 + "23456789TJQKA".indexOf(s[0]);
const hand = (s: string) => s.split(" ").map(card);
const cat = (s: string) => category(eval7(hand(s)));

/** Seeded RNG so a run is reproducible. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** Puts chosen cards on top of the deck: seat 0 gets s0, seat 1 gets s1, then the board. */
function rig(p: Practice, s0: string, s1: string, board: string): Practice {
  const top = [...hand(s0), ...hand(s1), ...hand(board)];
  const ordered = [top[0], top[2], top[1], top[3], ...top.slice(4)];
  return { ...p, deck: [...ordered, ...p.deck.filter((c) => !ordered.includes(c))] };
}

const total = (p: Practice) => p.table.stacks[0] + p.table.stacks[1] + p.table.pot;

describe("eval7 (port of eval.rs)", () => {
  it("detects every category", () => {
    expect(cat("As Kd 9c 7h 5s 3d 2c")).toBe(HIGH_CARD);
    expect(cat("As Ad 9c 7h 5s 3d 2c")).toBe(PAIR);
    expect(cat("As Ad 9c 9h 5s 3d 2c")).toBe(TWO_PAIR);
    expect(cat("As Ad Ac 7h 5s 3d 2c")).toBe(TRIPS);
    expect(cat("5s 6d 7c 8h 9s Kd 2c")).toBe(STRAIGHT);
    expect(cat("As 9s 7s 5s 3s Kd 2c")).toBe(FLUSH);
    expect(cat("As Ad 9c 9h 9s 3d 2c")).toBe(FULL_HOUSE);
    expect(cat("As Ad Ac Ah 5s 3d 2c")).toBe(QUADS);
    expect(cat("5s 6s 7s 8s 9s Kd 2c")).toBe(STRAIGHT_FLUSH);
  });

  it("orders hands: wheel lowest straight, kickers count, two trips make a full house", () => {
    expect(eval7(hand("2s 3d 4c 5h 6s Kd 9c"))).toBeGreaterThan(eval7(hand("As 2d 3c 4h 5s Kd 9c")));
    expect(eval7(hand("Ts Jd Qc Kh As 2d 3c"))).toBeGreaterThan(eval7(hand("9s Td Jc Qh Ks 2d 3c")));
    expect(eval7(hand("As Ad Kc 7h 5s 3d 2c"))).toBeGreaterThan(eval7(hand("As Ad Qc 7h 5s 3d 2c")));
    expect(cat("Ks Kd Kc 5h 5s 5d 2c")).toBe(FULL_HOUSE);
    expect(eval7(hand("Ks Kd Kc 5h 5s 5d 2c"))).toBeGreaterThan(eval7(hand("Qs Qd Qc As Ad 5d 2c")));
    expect(cat("2h 5h 7h 9h Kh 6d 8c")).toBe(FLUSH);
  });
});

describe("practice engine (port of engine.rs)", () => {
  it("posts turbo blinds and waits for the deal", () => {
    const p = newPractice(0, rng(1));
    const t = p.table;
    expect(t.handNo).toBe(1);
    expect(t.phase).toBe(PHASE.shuffle);
    expect([t.smallBlind, t.bigBlind]).toEqual([50n, 100n]);
    expect(t.bets).toEqual([50n, 100n]);
    expect(t.pot).toBe(150n);
    const d = deal(p, 0);
    expect(d.table.phase).toBe(PHASE.preflop);
    expect(d.table.toAct).toBe(0);
    expect(legalMoves(d.table, 0)).toMatchObject({ toCall: 50n, minTo: 200n, maxTo: 1500n });
  });

  it("plays a checked-down hand to showdown and the best hand takes the pot", () => {
    let p = rig(newPractice(0, rng(2)), "As Ah", "Kd Kc", "2c 7d 9h Js 3s");
    p = deal(p, 0);
    p = act(p, 0, call(), 0);
    p = act(p, 1, check(), 0);
    expect(p.table.phase).toBe(PHASE.flop);
    expect(p.table.board.slice(0, 3)).toEqual(hand("2c 7d 9h"));
    expect(p.table.board[3]).toBe(NO_CARD);
    expect(p.table.toAct).toBe(1);
    for (let street = 0; street < 3; street++) {
      p = act(p, 1, check(), 0);
      p = act(p, 0, check(), 0);
    }
    const lh = p.table.lastHand;
    expect(lh).toMatchObject({ handNo: 1, result: 0, pot: 200n, showdown: true });
    // Seat 0 won 1600 total, then hand 2 posts blinds 100/200 with seat 1 on the button.
    expect(p.table.stacks).toEqual([1600n - 200n, 1400n - 100n]);
    expect(p.table.handNo).toBe(2);
    expect(p.table.dealer).toBe(1);
    expect(total(p)).toBe(STARTING_CHIPS * 2n);
  });

  it("splits a tied pot with the odd chip to the big blind", () => {
    let p = rig(newPractice(0, rng(3)), "2c 3d", "2h 3s", "As Ks Qd Jc Th");
    p = deal(p, 0);
    p = act(p, 0, call(), 0);
    p = act(p, 1, check(), 0);
    for (let street = 0; street < 3; street++) {
      p = act(p, 1, check(), 0);
      p = act(p, 0, check(), 0);
    }
    expect(p.table.lastHand.result).toBe(SPLIT);
    expect(total(p)).toBe(STARTING_CHIPS * 2n);
  });

  it("a fold gives the pot to the other Player without a showdown", () => {
    let p = deal(newPractice(0, rng(4)), 0);
    p = act(p, 0, raise(300n), 0);
    p = act(p, 1, fold(), 0);
    expect(p.table.lastHand).toMatchObject({ result: 0, pot: 400n, showdown: false });
    expect(total(p)).toBe(STARTING_CHIPS * 2n);
  });

  it("an all-in call runs the board out and can end the Match", () => {
    let p = rig(newPractice(0, rng(5)), "As Ah", "7d 2c", "Kc Kd 9h 4s 3s");
    p = deal(p, 0);
    p = act(p, 0, raise(1500n), 0);
    p = act(p, 1, call(), 0);
    expect(p.table.status).toBe(STATUS.over);
    expect(p.table.winner).toBe(0);
    expect(p.table.stacks).toEqual([3000n, 0n]);
    expect(p.table.lastHand.board).toEqual(hand("Kc Kd 9h 4s 3s"));
  });

  it("returns the uncalled part of an over-bet", () => {
    let p = deal(newPractice(0, rng(6)), 0);
    p = act(p, 0, call(), 0);
    p = act(p, 1, check(), 0);
    p = act(p, 1, raise(500n), 0);
    p = act(p, 0, raise(1400n), 0);
    p = act(p, 1, call(), 0);
    // Seat 1 had 1400 behind before the flop, both are all-in for the same amount.
    expect(p.table.lastHand.pot).toBe(3000n);
    expect(total(p)).toBe(STARTING_CHIPS * 2n);
  });

  it("rejects illegal actions", () => {
    const p = deal(newPractice(0, rng(7)), 0);
    expect(() => act(p, 1, check(), 0)).toThrow("Not your turn");
    expect(() => act(p, 0, check(), 0)).toThrow("Cannot check");
    expect(() => act(p, 0, raise(150n), 0)).toThrow("Raise too small");
    expect(() => act(p, 0, raise(5000n), 0)).toThrow("Not enough chips");
  });
});

describe("practice bot", () => {
  it("rates aces far above seven-deuce", () => {
    expect(equity(hand("As Ah") as [number, number], [], 400, rng(8))).toBeGreaterThan(0.75);
    expect(equity(hand("7d 2c") as [number, number], [], 400, rng(9))).toBeLessThan(0.4);
  });

  it("plays whole Matches against itself with only legal actions, chips conserved", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 7919);
      let p = newPractice(0, r);
      let steps = 0;
      while (p.table.status === STATUS.live && steps < 2000) {
        if (p.table.phase === PHASE.shuffle) p = deal(p, 0, r);
        else {
          const s = p.table.toAct;
          const h: [number, number] = s === 0 ? [p.deck[0], p.deck[2]] : [p.deck[1], p.deck[3]];
          p = act(p, s, botAction(p.table, s, h, r), 0, r);
        }
        expect(total(p)).toBe(STARTING_CHIPS * 2n);
        steps++;
      }
      expect(p.table.status).toBe(STATUS.over);
    }
  });
});
