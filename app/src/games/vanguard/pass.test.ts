import { describe, expect, it } from "vitest";
import { DEPOTS, MOVE_CAP, PRACTICE_CLOCK, RULES_VERSION, TURN_MS, act, hasAction, move, pass, startTwoStep, timeout, type Game, type Piece, type Rank } from "./rules";

const T0 = 1_000_000;
const P = (id: number, army: "us" | "it", rank: Rank, r: number, c: number, extra: Partial<Piece> = {}): Piece => ({ id, army, rank, r, c, known: false, fuel: 0, trail: [`${r},${c}`], ...extra });

function game(pieces: Piece[], over: Partial<Game> = {}): Game {
  return {
    pieces, depots: DEPOTS.map((d) => ({ ...d })), turn: "us", turnNo: 0, moves: 0, twoStep: { us: 0, it: 0 }, stepsLeft: 1, twoStepActive: false,
    timeouts: { us: 0, it: 0 }, truckTurn: { us: -9, it: -9 }, movedThisTurn: [], startedAt: T0, clock: PRACTICE_CLOCK, deadline: T0 + TURN_MS,
    stormAt: 999, stormSeed: 7, stormDone: true, eventSeq: 0, winner: null, reason: null, version: RULES_VERSION, changed: {}, ...over,
  };
}
const at = (g: Game) => g.deadline - 1000;
const ok = (r: ReturnType<typeof pass>) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const doPass = (g: Game, extra: { switch?: boolean; digIn?: number } = {}) => ok(pass(g, { at: at(g), ...extra }));
const doMove = (g: Game, id: number, r: number, c: number) => ok(move(g, { id, to: { r, c }, at: at(g) }));
const refused = (r: ReturnType<typeof move>) => (r.ok ? "accepted" : r.reason);

const IT = P(90, "it", "2", 0, 9);
const US = P(91, "us", "2", 9, 3);
/** Both sides pass in turn until `army` has passed `n` times. */
const base = () => game([P(1, "us", "7", 7, 0), P(2, "us", "6", 8, 0), P(3, "us", "10", 6, 6), US, IT]);

describe("pass", () => {
  it("ends the turn, counts as a missed turn and is not a move for the cap", () => {
    const g = base();
    const r = doPass(g);
    expect(r.game.turn).toBe("it");
    expect(r.game.timeouts).toEqual({ us: 1, it: 0 });
    expect(r.game.moves).toBe(0);
    expect(r.game.pieces).toEqual(g.pieces);
    expect(r.events).toEqual([
      { kind: "pass", army: "us", seq: 0 },
      { kind: "turn", turn: "it", timedOut: false, seq: 1 },
    ]);
  });
  it("the next deadline counts from the pass like a move's", () => {
    const r = ok(pass(base(), { at: T0 + 2000 }));
    expect(r.game.deadline).toBe(T0 + 2000 + TURN_MS);
  });
  it("three passes in a row lose with the timeouts reason", () => {
    let g = base();
    g = doPass(g).game;
    g = doMove(g, 90, 1, 9).game; // Italy moves
    g = doPass(g).game;
    expect(g.timeouts.us).toBe(2);
    g = doMove(g, 90, 0, 9).game;
    const last = doPass(g);
    expect(last.game).toMatchObject({ winner: "it", reason: "timeouts" });
    expect(last.events.at(-1)).toMatchObject({ kind: "end", winner: "it", reason: "timeouts" });
  });
  it("passes and timeouts mix: pass, timeout, pass loses", () => {
    let g = base();
    g = doPass(g).game;
    g = { ...doMove(g, 90, 1, 9).game };
    const t = timeout(g.turn === "us" ? g : g, g.deadline + 1);
    if (!t.ok) throw new Error(t.reason);
    g = t.game;
    expect(g.timeouts.us).toBe(2);
    g = doMove(g, 90, 0, 9).game;
    expect(doPass(g).game).toMatchObject({ winner: "it", reason: "timeouts" });
  });
  it("a move in between resets the missed turns", () => {
    let g = base();
    g = doPass(g).game;
    g = doMove(g, 90, 1, 9).game;
    g = doPass(g).game;
    g = doMove(g, 90, 0, 9).game;
    g = doMove(g, 91, 8, 3).game; // Us moves: count back to 0
    expect(g.timeouts.us).toBe(0);
    g = doMove(g, 90, 1, 9).game;
    expect(doPass(g).game.winner).toBeNull();
  });
  it("a Blast or Rescue also resets the count", () => {
    const g = game([P(1, "us", "3", 9, 5), US, IT], { timeouts: { us: 2, it: 0 } });
    const r = ok(act(g, { kind: "blast", id: 1, at: at(g) }));
    expect(r.game.timeouts.us).toBe(0);
  });
  it("does not count toward the 200-move cap", () => {
    const g = game([P(1, "us", "7", 7, 0), US, IT], { moves: MOVE_CAP - 1 });
    const r = doPass(g);
    expect(r.game.moves).toBe(MOVE_CAP - 1);
    expect(r.game.winner).toBeNull();
  });
  it("is refused inside an active Two-Step Turn and after a step", () => {
    const g = { ...base(), twoStep: { us: 1, it: 0 } };
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    expect(refused(pass(s.game, { at: T0 + 2 }))).toBe("illegal_move");
    expect(refused(pass(s.game, { at: T0 + 2, digIn: 1 }))).toBe("illegal_move");
    const m = ok(move(s.game, { id: 91, to: { r: 8, c: 3 }, at: T0 + 2 }) as ReturnType<typeof pass>);
    expect(m.game.stepsLeft).toBe(1);
    expect(refused(pass(m.game, { at: T0 + 3 }))).toBe("illegal_move");
  });
  it("is refused on a late clock, after the end and on a version 5 Battle", () => {
    expect(refused(pass(base(), { at: T0 + TURN_MS + 1 }))).toBe("turn_expired");
    expect(refused(pass({ ...base(), winner: "it", reason: "stuck" }, { at: T0 + 1 }))).toBe("match_over");
    expect(refused(pass({ ...base(), version: 5 }, { at: T0 + 1 }))).toBe("illegal_move");
  });
  it("does not count as an action for the no-legal-move ending", () => {
    const g = game([P(1, "us", "B", 9, 0), P(2, "it", "7", 0, 0)]);
    expect(hasAction(g, "us")).toBe(false);
    const stuck = game([P(1, "us", "2", 9, 0), P(2, "it", "B", 0, 0)], { turn: "it" });
    expect(hasAction(stuck, "it")).toBe(false);
  });
  it("Become a Spy may ride on a pass, secretly on a face-down 10", () => {
    const r = doPass(base(), { switch: true });
    expect(r.game.changed).toEqual({ 3: "spy" });
    expect(r.events.map((e) => e.kind)).toEqual(["pass", "turn"]);
    expect(r.game.timeouts.us).toBe(1);
  });
  it("a switch on a face-up 10 is public", () => {
    const g = game([P(3, "us", "10", 6, 6, { known: true }), US, IT]);
    expect(doPass(g, { switch: true }).events.map((e) => e.kind)).toEqual(["switched", "pass", "turn"]);
  });
  it("a switch with no 10 does nothing", () => {
    const g = game([P(1, "us", "7", 7, 0), US, IT]);
    expect(doPass(g, { switch: true }).game.changed).toEqual({});
  });
});

describe("Dig in is a pass", () => {
  it("a face-down dig-in changes the piece but looks exactly like a pass in public", () => {
    const g = base();
    const plain = doPass(g);
    const dig = doPass(g, { digIn: 1 });
    expect(dig.game.changed).toEqual({ 1: "dug" });
    // everything the opponent can see: all of Game except the private change map
    expect({ ...dig.game, changed: {} }).toEqual({ ...plain.game, changed: {} });
    expect(dig.events).toEqual(plain.events);
    expect(dig.game.timeouts).toEqual({ us: 1, it: 0 });
    expect(dig.game.moves).toBe(0);
    expect(dig.game.pieces.find((p) => p.id === 1)!.known).toBe(false);
  });
  it("the same holds through act({kind: dig_in}), and over a storm turn", () => {
    const g = { ...base(), stormDone: false, stormAt: 1 };
    const viaAct = ok(act(g, { kind: "dig_in", id: 1, at: at(g) }) as ReturnType<typeof pass>);
    const plain = doPass(g);
    expect(viaAct.events).toEqual(plain.events);
    expect(viaAct.game.pieces.map((p) => [p.id, p.r, p.c])).toEqual(plain.game.pieces.map((p) => [p.id, p.r, p.c]));
  });
  it("a dig-in no longer resets the missed turns and is not a move", () => {
    const g = { ...base(), timeouts: { us: 2, it: 0 } };
    const r = doPass(g, { digIn: 1 });
    expect(r.game).toMatchObject({ winner: "it", reason: "timeouts" });
  });
  it("three dig-ins and passes in a row lose", () => {
    let g = game([P(1, "us", "7", 7, 0), P(2, "us", "7", 7, 1), P(3, "us", "7", 7, 2), US, IT]);
    g = doPass(g, { digIn: 1 }).game;
    g = doMove(g, 90, 1, 9).game;
    g = doPass(g, { digIn: 2 }).game;
    g = doMove(g, 90, 0, 9).game;
    const r = doPass(g, { digIn: 3 });
    expect(r.game).toMatchObject({ winner: "it", reason: "timeouts" });
  });
  it("a face-up Major's dig-in is named, and still a missed turn and not a move", () => {
    const g = game([P(1, "us", "7", 7, 0, { known: true }), US, IT]);
    const r = doPass(g, { digIn: 1 });
    expect(r.events.map((e) => e.kind)).toEqual(["dug_in", "pass", "turn"]);
    expect(r.events[0]).toMatchObject({ kind: "dug_in", army: "us", id: 1 });
    expect(r.game).toMatchObject({ moves: 0, timeouts: { us: 1, it: 0 } });
  });
  it("an invalid dig-in is a plain pass with no extra penalty", () => {
    const g = base();
    const plain = doPass(g);
    const dug = { ...g, changed: { 1: "dug" as const } };
    const invalid: Parameters<typeof doPass>[1][] = [{ digIn: 2 }, { digIn: 77 }, { digIn: 90 }, { digIn: 3 }];
    for (const extra of invalid) {
      const r = doPass(g, extra);
      expect(r.game).toEqual(plain.game);
      expect(r.events).toEqual(plain.events);
    }
    const again = doPass(dug, { digIn: 1 });
    expect(again.game.changed).toEqual({ 1: "dug" });
    expect(again.game.timeouts.us).toBe(1);
    expect(again.events).toEqual(plain.events);
  });
  it("a dig-in with a switch does both", () => {
    const r = doPass(base(), { digIn: 1, switch: true });
    expect(r.game.changed).toEqual({ 1: "dug", 3: "spy" });
    expect(r.events.map((e) => e.kind)).toEqual(["pass", "turn"]);
  });
  it("Game has no public dig counter", () => {
    expect(base()).not.toHaveProperty("digs");
  });
});

describe("version 5 is unaffected", () => {
  it("a version 5 Battle never reads a pass or a dig-in", () => {
    const g = { ...base(), version: 5 };
    expect(refused(pass(g, { at: T0 + 1, digIn: 1 }))).toBe("illegal_move");
    expect(refused(act(g, { kind: "dig_in", id: 1, at: T0 + 1 }))).toBe("illegal_move");
    const t = timeout(g, g.deadline + 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game.timeouts.us).toBe(1);
  });
});
