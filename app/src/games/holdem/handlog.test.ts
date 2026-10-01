import { describe, expect, it } from "vitest";
import { NO_CARD, NO_WINNER, PHASE } from "./chain";
import { EMPTY_LOG, stepHandLog, type HandLog, type TableRead } from "./handlog";

// Board: As Kd 7h 2c 9s (cardName order: rank + 13 * suit, suits c d h s).
const BOARD = [12 + 39, 11 + 13, 5 + 26, 0, 7 + 39];
const NO_BOARD = [NO_CARD, NO_CARD, NO_CARD, NO_CARD, NO_CARD];
const noLast: TableRead["lastHand"] = { handNo: 0, result: NO_WINNER, pot: 0n, showdown: false, shown: [[NO_CARD, NO_CARD], [NO_CARD, NO_CARD]], board: NO_BOARD };

/** Hand 1, seat 0 is the dealer (small blind 10, big blind 20), 1,500 Chips each. */
const read = (over: Partial<TableRead>): TableRead => {
  const bets = over.bets ?? [10n, 20n];
  const stacks = over.stacks ?? [1500n - bets[0], 1500n - bets[1]];
  return { handNo: 1, phase: PHASE.preflop, dealer: 0, smallBlind: 10n, bigBlind: 20n, toAct: 0, board: NO_BOARD, lastHand: noLast, pot: bets[0] + bets[1], ...over, bets, stacks };
};
/** The next hand has begun after hand 1 ended this way. */
const ended = (lastHand: Partial<TableRead["lastHand"]>): TableRead =>
  read({ handNo: 2, phase: PHASE.shuffle, dealer: 1, bets: [20n, 10n], stacks: [1000n, 1000n], lastHand: { ...noLast, handNo: 1, board: BOARD, ...lastHand } });

const run = (reads: TableRead[], from: HandLog = EMPTY_LOG) => reads.reduce((log, t) => stepHandLog(log, t, 0), from);
const view = (log: HandLog) => log.streets.map((s) => [s.name, ...s.rows.map((r) => `${r.who}: ${r.text}`)]);

describe("hand log inference", () => {
  it("keeps the Flop and Turn of an all-in runout and logs the call that started it", () => {
    const log = run([
      read({}),
      read({ bets: [1500n, 20n], stacks: [0n, 1480n], toAct: 1 }),
      ended({ result: 1, pot: 3000n, showdown: true }),
    ]);
    expect(view(log)).toEqual([
      ["Pre-flop", "You: Small blind 10", "Opponent: Big blind 20", "You: Raise to 1,500 · all-in", "Opponent: Call 1,480 · all-in"],
      ["Flop", "Board: As Kd 7h"],
      ["Turn", "Board: 2c"],
      ["River", "Board: 9s", "Both: Showdown"],
    ]);
    expect(log.done).toBe(true);
  });

  it("logs the closing call on the River before the showdown", () => {
    const river = (over: Partial<TableRead>) => read({ phase: PHASE.river, board: BOARD, pot: 400n, bets: [0n, 0n], stacks: [1300n, 1300n], toAct: 1, ...over });
    const start: HandLog = { hand: 1, done: false, streets: [{ name: "River", rows: [{ who: "Board", text: "9s" }] }], prev: river({}) };
    const log = run([river({ bets: [0n, 200n], stacks: [1300n, 1100n], pot: 600n, toAct: 0 }), ended({ result: 0, pot: 800n, showdown: true })], start);
    expect(view(log)).toEqual([["River", "Board: 9s", "Opponent: Bet 200", "You: Call 200", "Both: Showdown"]]);
  });

  it("logs a River checked through", () => {
    const river = read({ phase: PHASE.river, board: BOARD, pot: 400n, bets: [0n, 0n], stacks: [1300n, 1300n], toAct: 1 });
    const start: HandLog = { hand: 1, done: false, streets: [{ name: "River", rows: [] }], prev: river };
    expect(view(run([ended({ result: 1, pot: 400n, showdown: true })], start))).toEqual([["River", "Opponent: Check", "You: Check", "Both: Showdown"]]);
  });

  it("adds a street the reads skipped instead of dropping it", () => {
    const flop = read({ phase: PHASE.flop, board: [...BOARD.slice(0, 3), NO_CARD, NO_CARD], pot: 40n, bets: [0n, 0n], stacks: [1480n, 1480n], toAct: 1 });
    const river = read({ phase: PHASE.river, board: BOARD, pot: 40n, bets: [0n, 0n], stacks: [1480n, 1480n], toAct: 1 });
    const start: HandLog = { hand: 1, done: false, streets: [{ name: "Flop", rows: [{ who: "Board", text: "As Kd 7h" }] }], prev: flop };
    expect(view(run([river], start))).toEqual([
      ["Flop", "Board: As Kd 7h", "Opponent: Check", "You: Check"],
      ["Turn", "Board: 2c"],
      ["River", "Board: 9s"],
    ]);
  });

  it("logs the big blind's check after a small blind call that closed the street", () => {
    const flop = read({ phase: PHASE.flop, board: [...BOARD.slice(0, 3), NO_CARD, NO_CARD], pot: 40n, bets: [0n, 0n], stacks: [1480n, 1480n], toAct: 1 });
    expect(view(run([read({}), flop]))).toEqual([
      ["Pre-flop", "You: Small blind 10", "Opponent: Big blind 20", "You: Call 10", "Opponent: Check"],
      ["Flop", "Board: As Kd 7h"],
    ]);
  });

  it("logs a bet and a raise seen in one read in order", () => {
    const flop = read({ phase: PHASE.flop, board: [...BOARD.slice(0, 3), NO_CARD, NO_CARD], pot: 40n, bets: [0n, 0n], stacks: [1480n, 1480n], toAct: 1 });
    const start: HandLog = { hand: 1, done: false, streets: [{ name: "Flop", rows: [] }], prev: flop };
    const log = run([read({ phase: PHASE.flop, board: flop.board, pot: 640n, bets: [400n, 200n], stacks: [1080n, 1280n], toAct: 1 })], start);
    expect(view(log)).toEqual([["Flop", "Opponent: Bet 200", "You: Raise to 400"]]);
  });

  it("changes nothing when the same read comes twice", () => {
    const reads = [read({}), read({ bets: [60n, 20n], toAct: 1 })];
    const once = run(reads);
    expect(view(run([reads[1]], once))).toEqual(view(once));
  });

  it("logs a fold", () => {
    expect(view(run([read({}), ended({ result: 1, pot: 30n })]))).toEqual([["Pre-flop", "You: Small blind 10", "Opponent: Big blind 20", "You: Fold"]]);
  });
});
