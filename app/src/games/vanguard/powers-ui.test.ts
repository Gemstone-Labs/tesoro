import { describe, expect, it } from "vitest";
import { blastSquares, canSwitch, changeLines, isJump, observe, powerFor, rosterView, type Ledger } from "./powers-ui";
import { DEPOTS, PRACTICE_CLOCK, RULES_VERSION, TURN_MS, move, type Game, type GameEvent, type GameEventBody, type Piece, type Rank } from "./rules";

const T0 = 1_000_000;
const P = (id: number, army: "us" | "it", rank: Rank, r: number, c: number, extra: Partial<Piece> = {}): Piece => ({ id, army, rank, r, c, known: false, fuel: 0, trail: [`${r},${c}`], ...extra });
const game = (pieces: Piece[], over: Partial<Game> = {}): Game => ({
  pieces,
  depots: DEPOTS.map((d) => ({ ...d })),
  turn: "us",
  turnNo: 0,
  moves: 0,
  twoStep: { us: 0, it: 0 },
  stepsLeft: 1,
  twoStepActive: false,
  timeouts: { us: 0, it: 0 },
  truckTurn: { us: -9, it: -9 },
  movedThisTurn: [],
  startedAt: T0,
  clock: PRACTICE_CLOCK,
  deadline: T0 + TURN_MS,
  stormAt: 999,
  stormSeed: 7,
  stormDone: true,
  eventSeq: 0,
  winner: null,
  reason: null,
  version: RULES_VERSION,
  changed: {},
  ...over,
});
const ev = (e: GameEventBody) => ({ ...e, seq: 0 }) as GameEvent;
const cell = (g: Game, l: Ledger, rank: Rank) => rosterView(g, l).cells.find((c) => c.rank === rank)!;

describe("blast preview", () => {
  it("is the 8 squares around, never wrapping past an edge", () => {
    expect(blastSquares({ r: 5, c: 5 })).toHaveLength(8);
    expect(blastSquares({ r: 0, c: 0 }).map((s) => `${s.r},${s.c}`).sort()).toEqual(["0,1", "1,0", "1,1"]);
    expect(blastSquares({ r: 9, c: 9 }).map((s) => `${s.r},${s.c}`).sort()).toEqual(["8,8", "8,9", "9,8"]);
  });
});

describe("jump marks", () => {
  it("arc for a Lieutenant jump and a General crossing, not for a step or another rank's run", () => {
    expect(isJump("5", { r: 6, c: 4 }, { r: 4, c: 4 })).toBe(true);
    expect(isJump("9", { r: 6, c: 4 }, { r: 3, c: 4 })).toBe(true);
    expect(isJump("5", { r: 6, c: 4 }, { r: 5, c: 4 })).toBe(false);
    expect(isJump("2", { r: 6, c: 4 }, { r: 2, c: 4 })).toBe(false);
    expect(isJump("4", { r: 6, c: 4 }, { r: 3, c: 7 })).toBe(false);
  });
});

describe("the power button", () => {
  const g = game([P(30, "us", "3", 6, 4), P(31, "us", "8", 7, 4), P(32, "us", "F", 8, 4), P(33, "us", "7", 7, 5), P(34, "us", "6", 7, 6), P(0, "it", "2", 0, 0)]);
  const opt = (id: number, over: Partial<Game> = {}) => powerFor({ ...g, ...over }, g.pieces.find((p) => p.id === id)!)?.label ?? null;
  it("names the power of an Engineer, Colonel and Major, and nothing for other ranks", () => {
    expect(opt(30)).toBe("Blast");
    expect(opt(31)).toBe("Rescue");
    expect(opt(33)).toBe("Dig in");
    expect(opt(34)).toBeNull();
  });
  it("goes away inside a Two-Step Turn and when the Colonel has no Truck", () => {
    expect(opt(30, { twoStepActive: true })).toBeNull();
    expect(powerFor(game([P(31, "us", "8", 7, 4), P(0, "it", "2", 0, 0)]), P(31, "us", "8", 7, 4))).toBeNull();
  });
  it("is gone for a Major that already dug in", () => {
    expect(opt(33, { changed: { 33: "dug" } })).toBeNull();
  });
  it("lets only the unswitched 10 become a Spy", () => {
    const t = game([P(30, "us", "10", 6, 4), P(0, "it", "2", 0, 0)]);
    expect(canSwitch(t, t.pieces[0])).toBe(true);
    expect(canSwitch({ ...t, changed: { 30: "spy" } }, t.pieces[0])).toBe(false);
    expect(canSwitch(t, P(31, "us", "9", 6, 5))).toBe(false);
  });
});

describe("the enemy roster strip", () => {
  const board = game([P(0, "it", "10", 0, 0), P(1, "it", "1", 0, 1), P(2, "it", "7", 0, 2), P(3, "it", "7", 0, 3), P(4, "it", "B", 0, 4), P(30, "us", "2", 9, 9)]);

  it("starts as the full roster, with the 10 unproven", () => {
    const v = rosterView(board, {});
    expect(v.cells.map((c) => `${c.rank}${c.left}/${c.of}`).join(" ")).toBe("101/1 91/1 81/1 72/2 62/2 52/2 42/2 32/2 23/3 11/1 B2/2 F1/1");
    expect(v.tenOrSpy).toBe(true);
  });
  it("counts shown pieces that left the board, and not the pieces that are only face up", () => {
    const after = { ...board, pieces: board.pieces.filter((p) => p.id !== 2) };
    const l: Ledger = { 2: ["7"], 3: ["7"] };
    expect(cell(after, l, "7").left).toBe(1); // 3 is shown but still on the board
  });
  it("never shows a Dig in: the strip is the same whatever the enemy has dug in", () => {
    expect(rosterView({ ...board, changed: { 5: "dug", 6: "dug" } }, {})).toEqual(rosterView(board, {}));
  });
  it("a switched 10 that dies shows as a Spy: the Spy is gone and the 10 is still unproven", () => {
    const after = { ...board, pieces: board.pieces.filter((p) => p.id !== 0), changed: { 0: "spy" as const } };
    const events = [ev({ kind: "attack", att: 30, def: 0, from: { r: 9, c: 9 }, to: { r: 0, c: 0 }, outcome: "win", flash: [0] })];
    const l = observe({}, events, board, after);
    expect(l[0]).toEqual(["1"]);
    expect(cell(after, l, "1").left).toBe(0);
    expect(cell(after, l, "10").left).toBe(1);
    expect(rosterView(after, l).tenOrSpy).toBe(true);
  });
  it("proves the switch once two Spies were shown", () => {
    const l: Ledger = { 0: ["1"], 1: ["1"] };
    const after = { ...board, pieces: board.pieces.filter((p) => p.id > 1) };
    const v = rosterView(after, l);
    expect(v.tenOrSpy).toBe(false);
    expect(v.cells.find((c) => c.rank === "10")!.left).toBe(0);
    expect(v.cells.find((c) => c.rank === "1")).toMatchObject({ of: 2, left: 0 });
  });
  it("a 10 seen as a 10 and later as a Spy is a proven switch", () => {
    expect(rosterView(board, { 0: ["10", "1"] }).tenOrSpy).toBe(false);
    expect(cell(board, { 0: ["10", "1"] }, "10").left).toBe(0);
  });
  it("a 10 seen face up stays a 10 and is no longer a question", () => {
    const v = rosterView(board, { 0: ["10"] });
    expect(v.tenOrSpy).toBe(false);
    expect(v.cells.find((c) => c.rank === "10")!.left).toBe(1);
  });
  it("survives a long Match: it reads the ledger, not the event ring", () => {
    const l: Ledger = { 2: ["7"] };
    const after = { ...board, pieces: board.pieces.filter((p) => p.id !== 2) };
    expect(rosterView(after, l)).toEqual(rosterView(after, { ...l }));
    expect(cell(after, l, "7").left).toBe(1);
  });
});

describe("observe", () => {
  const b = game([P(0, "it", "3", 3, 3), P(1, "it", "5", 3, 4), P(30, "us", "9", 4, 4), P(31, "us", "8", 8, 4), P(2, "it", "F", 0, 4)]);
  it("records a Blast, its Engineer and every piece shown, own pieces left out", () => {
    const e = ev({ kind: "blast", id: 0, at: { r: 3, c: 3 }, shown: [{ id: 1, rank: "5" }, { id: 30, rank: "9" }] });
    const l = observe({}, [e], b, b);
    expect(l).toEqual({ 0: ["3"], 1: ["5"] });
  });
  it("records a Rescue and a face-up switch and dig in, but not a hidden dig in", () => {
    const l = observe({ 1: ["5"] }, [ev({ kind: "rescue", colonel: 0, truck: 2, from: { r: 0, c: 4 }, to: { r: 3, c: 3 } }), ev({ kind: "switched", id: 1 }), ev({ kind: "pass", army: "it" })], b, b);
    expect(l).toEqual({ 0: ["8"], 2: ["F"], 1: ["5", "1"] });
  });
  it("is the same ledger when a move is replayed twice", () => {
    const g = game([P(30, "us", "9", 4, 4), P(1, "it", "7", 3, 4)]);
    const r = move(g, { id: 30, to: { r: 3, c: 4 }, at: T0 + 1 });
    if (!r.ok) throw new Error("refused");
    const once = observe({}, r.events, g, r.game);
    expect(observe(once, r.events, g, r.game)).toEqual(once);
    expect(once).toEqual({ 1: ["7"] });
  });
});

describe("the end panel marks", () => {
  it("names dug-in Majors and switched Generals of the Army for both armies, dead ones included", () => {
    const g = game([], { changed: { 31: "dug", 5: "spy", 32: "spy" } });
    expect(changeLines(g)).toEqual([
      { id: 5, army: "it", text: "General of the Army, now a Spy" },
      { id: 31, army: "us", text: "Major, dug in" },
      { id: 32, army: "us", text: "General of the Army, now a Spy" },
    ]);
  });
});
