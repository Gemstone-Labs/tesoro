import { describe, expect, it } from "vitest";
import { NO_CARD, call, check, fold, raise, type Action } from "./chain";
import { diffTable, type TableEvent } from "./events";
import { act, deal, newPractice, type Practice } from "./practice/engine";

const card = (s: string) => "cdhs".indexOf(s[1]) * 13 + "23456789TJQKA".indexOf(s[0]);
const hand = (s: string) => s.split(" ").map(card);
const NOW = 1_800_000_000;

/** Puts chosen cards on top of the deck: seat 0 gets s0, seat 1 gets s1, then the board. */
function rig(p: Practice, s0: string, s1: string, board: string): Practice {
  const top = [...hand(s0), ...hand(s1), ...hand(board)];
  const ordered = [top[0], top[2], top[1], top[3], ...top.slice(4)];
  return { ...p, deck: [...ordered, ...p.deck.filter((c) => !ordered.includes(c))] };
}

const start = (s0 = "As Kd", s1 = "2c 7h", board = "9s 8d 3h Jc 4s") => rig(newPractice(NOW), s0, s1, board);
const step = (p: Practice, seat: number, a: Action) => act(p, seat, a, NOW);
/** Short, readable form of the events a Player would see. */
const view = (events: TableEvent[]) =>
  events.map((e) => {
    switch (e.type) {
      case "action":
        return `${e.seat}:${e.kind}${e.amount ? ` ${e.amount}` : ""}${e.allIn ? " all-in" : ""}`;
      case "street":
        return `${e.street} ${e.cards.length}`;
      case "sweep":
        return `sweep ${e.amount}`;
      case "result":
        return `result ${e.winner} ${e.how} ${e.pot}`;
      case "newHand":
        return `hand ${e.handNo}${e.blindsUp ? " blinds-up" : ""}`;
      default:
        return e.type;
    }
  });
const diff = (a: Practice, b: Practice, seat: 0 | 1 = 0) => view(diffTable(a.table, b.table, seat));

describe("diffTable, read by read", () => {
  it("tells a whole hand: deal, calls, checks, streets, showdown", () => {
    const p0 = start();
    const p1 = deal(p0, NOW);
    expect(diff(p0, p1)).toEqual(["deal"]);
    const p2 = step(p1, 0, call());
    expect(diff(p1, p2)).toEqual(["0:call 50"]);
    const p3 = step(p2, 1, check());
    expect(diff(p2, p3)).toEqual(["1:check", "sweep 200", "flop 3"]);
    const p4 = step(p3, 1, check());
    expect(diff(p3, p4)).toEqual(["1:check"]);
    const p5 = step(p4, 0, check());
    expect(diff(p4, p5)).toEqual(["0:check", "turn 1"]);
    const p6 = step(p5, 1, raise(200));
    expect(diff(p5, p6)).toEqual(["1:bet 200"]);
    const p7 = step(p6, 0, raise(600));
    expect(diff(p6, p7)).toEqual(["0:raise 600"]);
    const p8 = step(p7, 1, call());
    expect(diff(p7, p8)).toEqual(["1:call 400", "sweep 1200", "river 1"]);
    const p9 = step(p8, 1, check());
    const p10 = step(p9, 0, check());
    // The practice engine starts the next hand at once, so the result and the new hand come in one read.
    expect(diff(p9, p10)).toEqual(["0:check", "result 0 showdown 1400", "hand 2 blinds-up"]);
  });

  it("describes the same hand from the other seat only by the seat index it reports", () => {
    const p1 = deal(start(), NOW);
    const p2 = step(p1, 0, raise(300));
    expect(view(diffTable(p1.table, p2.table, 1))).toEqual(["0:raise 300"]);
  });

  it("reports the opponent folding to a raise as a bet, a fold and a result", () => {
    const p1 = deal(start(), NOW);
    const p2 = step(p1, 0, raise(300));
    const p3 = step(p2, 1, fold());
    expect(diff(p2, p3)).toEqual(["1:fold", "sweep 400", "result 0 fold 400", "hand 2 blinds-up"]);
  });
});

describe("diffTable, merged reads", () => {
  it("never invents a wrong action when a bet and its call come in one read", () => {
    const p2 = step(deal(start(), NOW), 0, call());
    const p3 = step(p2, 1, check());
    const p4 = step(p3, 1, raise(300));
    const p5 = step(p4, 0, call());
    expect(diff(p3, p5)).toEqual(["1:bet 300", "0:call 300", "sweep 600", "turn 1"]);
  });

  it("reads a raise and a fold between two reads as the raise then the fold", () => {
    const p1 = deal(start(), NOW);
    const p3 = step(step(p1, 0, raise(300)), 1, fold());
    expect(diff(p1, p3)).toEqual(["0:raise 300", "1:fold", "sweep 400", "result 0 fold 400", "hand 2 blinds-up"]);
  });

  it("deals the rest of the board when an all-in is called", () => {
    const p1 = deal(start(), NOW);
    const p2 = step(p1, 0, raise(1500));
    expect(diff(p1, p2)).toEqual(["0:raise 1500 all-in"]);
    const p3 = step(p2, 1, call());
    expect(diff(p2, p3)).toEqual(["1:call 1400 all-in", "sweep 3000", "flop 3", "turn 1", "river 1", "result 0 showdown 3000"]);
  });

  it("reports a split pot", () => {
    const p1 = deal(start("2c 3d", "2d 3c", "As Ks Qh Jd Th"), NOW);
    const p2 = step(p1, 0, raise(1500));
    const p3 = step(p2, 1, call());
    expect(diff(p2, p3).at(-2)).toBe("result split showdown 3000");
  });

  it("reports nothing for a repeated read and nothing on a first read", () => {
    const p1 = deal(start(), NOW);
    expect(diffTable(p1.table, p1.table, 0)).toEqual([]);
    expect(diffTable(null, p1.table, 0)).toEqual([]);
  });

  it("flags blinds going up only when the level changed", () => {
    const p1 = deal(start(), NOW);
    const p3 = step(step(p1, 0, raise(300)), 1, fold());
    const events = diffTable(p1.table, p3.table, 0);
    const hand2 = events.find((e) => e.type === "newHand");
    expect(hand2).toMatchObject({ handNo: 2, blindsUp: true, smallBlind: 100n, bigBlind: 200n });
    expect(NO_CARD).toBe(255);
  });
});
