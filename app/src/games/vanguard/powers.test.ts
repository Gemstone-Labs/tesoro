import { describe, expect, it } from "vitest";
import { CAP_MS, DEPOTS, MOVE_CAP, PRACTICE_CLOCK, REFUSALS, RULES_VERSION, TURN_MS, act, fight, hasAction, hasStep, move, rankOf, startTwoStep, storm, targets, timeout, type ActAction, type Game, type Piece, type Rank } from "./rules";

const T0 = 1_000_000;

const P = (id: number, army: "us" | "it", rank: Rank, r: number, c: number, extra: Partial<Piece> = {}): Piece => ({ id, army, rank, r, c, known: false, fuel: 0, trail: [`${r},${c}`], ...extra });

function game(pieces: Piece[], over: Partial<Game> = {}): Game {
  return {
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
  };
}

const at = (g: Game) => g.deadline - 1000;
function go(g: Game, id: number, r: number, c: number, sw = false) {
  const res = move(g, { id, to: { r, c }, at: at(g), switch: sw });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res;
}
function doAct(g: Game, kind: ActAction["kind"], id: number, sw = false) {
  const res = act(g, { kind, id, at: at(g), switch: sw });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res;
}
const refused = (r: ReturnType<typeof move>) => (r.ok ? "accepted" : r.reason);
const sq = (g: Game, id: number) => {
  const p = g.pieces.find((x) => x.id === id)!;
  return p ? `${p.r},${p.c}` : "gone";
};
const reach = (g: Game, id: number) => targets(g, g.pieces.find((p) => p.id === id)!).map((t) => `${t.r},${t.c}`).sort();
// a far-away enemy so the Match never ends by "stuck" in small set-ups
const IT = P(90, "it", "2", 0, 9);

describe("rules version 6", () => {
  it("is 6, and an Engineer no longer defuses", () => {
    expect(RULES_VERSION).toBe(6);
    expect(fight("3", "B")).toBe("mine");
    expect(fight("3", "B", 5)).toBe("defuse");
  });
  it("Battles on version 5 keep the old straight steps and the Engineer defuse", () => {
    const g = game([P(1, "us", "4", 6, 0), P(2, "us", "3", 9, 0), P(3, "it", "B", 8, 0), IT], { version: 5 });
    expect(reach(g, 1)).toEqual(["5,0", "6,1", "7,0"]);
    expect(refused(act(g, { kind: "blast", id: 2, at: at(g) }))).toBe("illegal_move");
    const d = go(g, 2, 8, 0);
    expect(d.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "defuse" });
  });
});

describe("Sergeant", () => {
  it("moves on diagonals only, never straight", () => {
    const g = game([P(1, "us", "4", 6, 4), IT]);
    for (const t of targets(g, g.pieces[0])) {
      expect(t.r).not.toBe(6);
      expect(t.c).not.toBe(4);
    }
    expect(reach(g, 1)).toContain("7,3");
    expect(reach(g, 1)).toContain("5,5");
  });
  it("runs any distance and stops at the first piece, attacking an enemy and blocked by its own", () => {
    const g = game([P(1, "us", "4", 9, 0), P(2, "it", "7", 6, 3), P(3, "us", "5", 7, 8), IT]);
    expect(reach(g, 1)).toEqual(["6,3", "7,2", "8,1"]);
    const g2 = game([P(1, "us", "4", 9, 0), P(3, "us", "5", 7, 2), IT]);
    expect(reach(g2, 1)).toEqual(["8,1"]);
  });
  it("is stopped by a wadi square", () => {
    const g = game([P(1, "us", "4", 7, 0), IT]);
    expect(reach(g, 1)).toEqual(["6,1", "8,1", "9,2"]);
  });
  it("slips past a canyon corner and between two pieces that touch at the corners", () => {
    const corner = game([P(1, "us", "4", 3, 3), IT]);
    expect(reach(corner, 1)).toEqual(expect.arrayContaining(["4,4", "5,5", "6,6"]));
    const between = game([P(1, "us", "4", 6, 4), P(2, "us", "5", 6, 3), P(3, "it", "6", 7, 4), IT]);
    expect(reach(between, 1)).toContain("7,3");
  });
  it("claims a depot with a one-square diagonal step, not with a longer run", () => {
    const one = go(game([P(1, "us", "4", 2, 4), IT]), 1, 1, 5);
    expect(one.events.some((e) => e.kind === "raid")).toBe(true);
    expect(one.game.twoStep.us).toBe(1);
    const run = go(game([P(1, "us", "4", 3, 3), IT]), 1, 1, 5);
    expect(run.events.some((e) => e.kind === "raid")).toBe(false);
    expect(run.game.twoStep.us).toBe(0);
  });
  it("changes square colour when the storm shifts it", () => {
    const g = game([P(1, "us", "4", 7, 0), P(2, "us", "5", 7, 1), IT], { stormSeed: 3 });
    for (let seed = 1; seed < 40; seed++) {
      const s = storm({ ...g, stormSeed: seed });
      if (s.event?.kind !== "storm") continue;
      const sh = s.event.shifts.find((x) => x.id === 1);
      if (!sh) continue;
      expect((sh.from.r + sh.from.c) % 2).not.toBe((sh.to.r + sh.to.c) % 2);
      const p = s.game.pieces.find((x) => x.id === 1)!;
      const all = reach({ ...s.game, stormDone: true }, 1).map((x) => x.split(",").map(Number));
      expect(all.every(([r, c]) => (r + c) % 2 === (p.r + p.c) % 2)).toBe(true);
    }
  });
  it("is limited to one diagonal square in a Two-Step Turn", () => {
    const g = game([P(1, "us", "4", 9, 0), IT], { twoStep: { us: 1, it: 0 } });
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    expect(reach(s.game, 1)).toEqual(["8,1"]);
  });
});

describe("Captain", () => {
  it("steps one square in any of 8 directions", () => {
    const g = game([P(1, "us", "6", 6, 4), P(2, "us", "5", 6, 5), P(3, "it", "4", 7, 3), IT]);
    expect(reach(g, 1)).toEqual(["5,4", "5,5", "6,3", "7,3", "7,4", "7,5"]);
    expect(targets(g, g.pieces[0]).find((t) => t.r === 7 && t.c === 3)!.attack).toBe(true);
  });
  it("does not enter a wadi", () => {
    const r = reach(game([P(1, "us", "6", 6, 2), IT]), 1);
    expect(r).toContain("5,1");
    expect(r).not.toContain("5,2");
    expect(r).not.toContain("5,3");
  });
});

describe("Lieutenant jump", () => {
  it("jumps an own piece, an enemy, a Landmine and a Truck onto the empty square behind", () => {
    for (const [army, rank] of [["us", "7"], ["it", "7"], ["it", "B"], ["us", "F"]] as const) {
      const g = game([P(1, "us", "5", 6, 4), P(2, army, rank, 5, 4), IT]);
      expect(reach(g, 1)).toContain("4,4");
    }
  });
  it("jumps sideways and downward too", () => {
    const g = game([P(1, "us", "5", 7, 4), P(2, "us", "7", 7, 5), P(3, "it", "7", 8, 4), P(4, "us", "7", 7, 3), IT]);
    expect(reach(g, 1)).toEqual(expect.arrayContaining(["7,6", "9,4", "7,2"]));
  });
  it("cannot jump an empty square", () => {
    expect(reach(game([P(1, "us", "5", 6, 4), IT]), 1)).toEqual(["5,4", "6,5", "6,3", "7,4"].sort());
  });
  it("attacks an enemy standing behind the jumped piece, and dies on a Landmine there", () => {
    const g = game([P(1, "us", "5", 6, 4), P(2, "us", "7", 5, 4), P(3, "it", "4", 4, 4), IT]);
    const win = go(g, 1, 4, 4);
    expect(win.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win", from: { r: 6, c: 4 }, to: { r: 4, c: 4 } });
    const m = game([P(1, "us", "5", 6, 4), P(2, "us", "7", 5, 4), P(3, "it", "B", 4, 4), IT]);
    const lost = go(m, 1, 4, 4);
    expect(lost.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "mine" });
    expect(sq(lost.game, 1)).toBe("gone");
  });
  it("refuses a landing on its own piece", () => {
    const g = game([P(1, "us", "5", 6, 4), P(2, "us", "7", 5, 4), P(3, "us", "7", 4, 4), IT]);
    expect(reach(g, 1)).not.toContain("4,4");
  });
  it("landing on the depot is a jump, so it claims nothing", () => {
    const g = game([P(1, "us", "5", 3, 5), P(2, "it", "7", 2, 5), IT]);
    const r = go(g, 1, 1, 5);
    expect(r.events.some((e) => e.kind === "raid")).toBe(false);
    expect(r.game.twoStep.us).toBe(0);
    expect(r.game.depots.find((d) => d.raider === "us")!.claimed).toBe(false);
  });
  it("cannot jump off the board or into a wadi", () => {
    const edge = game([P(1, "us", "5", 8, 0), P(2, "us", "7", 9, 0), IT]);
    expect(reach(edge, 1)).not.toContain("10,0");
    const corner = game([P(1, "us", "5", 0, 8), P(2, "it", "7", 0, 9), IT]);
    expect(reach(corner, 1).every((s) => Number(s.split(",")[1]) <= 9)).toBe(true);
    const wadi = game([P(1, "us", "5", 6, 2), P(2, "us", "7", 6, 3), P(3, "it", "6", 6, 1), IT]);
    expect(reach(wadi, 1)).not.toContain("4,2");
    const over = game([P(1, "us", "5", 3, 2), P(2, "us", "7", 4, 2), IT]);
    expect(reach(over, 1)).not.toContain("5,2");
  });
  it("jumping counts for the no-shuttling rule", () => {
    let g = game([P(1, "us", "5", 6, 4), P(2, "us", "7", 5, 4), P(4, "it", "4", 0, 8), IT]);
    const it = (x: Game) => {
      const t = targets(x, x.pieces.find((p) => p.id === 4)!)[0];
      return go(x, 4, t.r, t.c).game;
    };
    g = it(go(g, 1, 4, 4).game);
    g = it(go(g, 1, 6, 4).game);
    g = it(go(g, 1, 4, 4).game);
    expect(reach(g, 1)).not.toContain("6,4");
  });
  it("is refused inside a Two-Step Turn", () => {
    const g = game([P(1, "us", "5", 6, 4), P(2, "us", "7", 5, 4), IT], { twoStep: { us: 1, it: 0 } });
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    expect(reach(s.game, 1)).not.toContain("4,4");
    expect(refused(move(s.game, { id: 1, to: { r: 4, c: 4 }, at: T0 + 2 }))).toBe("illegal_move");
  });
});

describe("General wadi crossing", () => {
  const crossings: [number, number, number, number][] = [];
  for (const [lo, hi] of [[2, 3], [6, 7]]) {
    for (const r of [4, 5]) {
      crossings.push([r, lo - 1, r, hi + 1], [r, hi + 1, r, lo - 1]);
    }
    for (const c of [lo, hi]) crossings.push([3, c, 6, c], [6, c, 3, c]);
  }
  it("crosses straight over a wadi from every face of both", () => {
    expect(crossings).toHaveLength(16);
    for (const [r, c, tr, tc] of crossings) {
      const g = game([P(1, "us", "9", r, c), IT]);
      expect(reach(g, 1), `${r},${c}`).toContain(`${tr},${tc}`);
    }
  });
  it("attacks an enemy on the landing square and is refused an own piece there", () => {
    const g = game([P(1, "us", "9", 6, 2), P(2, "it", "4", 3, 2), IT]);
    const a = go(g, 1, 3, 2);
    expect(a.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win" });
    expect(reach(game([P(1, "us", "9", 6, 2), P(2, "us", "4", 3, 2), IT]), 1)).not.toContain("3,2");
  });
  it("refuses jumps that cross no wadi, and diagonal crossings", () => {
    const g = game([P(1, "us", "9", 3, 1), IT]);
    expect(reach(g, 1)).not.toContain("6,1");
    expect(reach(g, 1)).not.toContain("6,4");
    expect(reach(g, 1)).not.toContain("3,4");
    expect(reach(game([P(1, "us", "9", 3, 4), IT]), 1)).not.toContain("6,4");
  });
  it("does not claim a depot, and is refused in a Two-Step Turn", () => {
    const g = game([P(1, "us", "9", 6, 2), IT], { twoStep: { us: 1, it: 0 } });
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    expect(reach(s.game, 1)).not.toContain("3,2");
  });
});

describe("Blast", () => {
  it("removes the Engineer, shows every neighbour for good, hurts nothing and passes the turn", () => {
    const g = game([
      P(1, "us", "3", 5, 5),
      P(2, "us", "7", 5, 4),
      P(3, "it", "B", 4, 4),
      P(4, "it", "F", 6, 6),
      P(5, "it", "9", 4, 5),
      P(6, "it", "5", 7, 5), // two away
      IT,
    ]);
    const r = doAct(g, "blast", 1);
    const e = r.events.find((x) => x.kind === "blast");
    expect(e).toMatchObject({ kind: "blast", id: 1, at: { r: 5, c: 5 } });
    if (e?.kind !== "blast") return;
    expect(e.shown.map((s) => s.id).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(e.shown.find((s) => s.id === 3)!.rank).toBe("B");
    expect(r.game.pieces.map((p) => p.id).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 90]);
    for (const id of [2, 3, 4, 5]) expect(r.game.pieces.find((p) => p.id === id)!.known).toBe(true);
    expect(r.game.pieces.find((p) => p.id === 6)!.known).toBe(false);
    expect(r.game.turn).toBe("it");
    expect(r.game.moves).toBe(1);
  });
  it("works at every corner and edge without wrapping or reaching a wadi", () => {
    const squares: [number, number][] = [[0, 0], [0, 9], [9, 0], [9, 9], [3, 9], [6, 0], [3, 2], [6, 3]];
    for (const [r, c] of squares) {
      const ring: Piece[] = [];
      let id = 10;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && r + dr >= 0 && r + dr < 10 && c + dc >= 0 && c + dc < 10 && !((r + dr === 4 || r + dr === 5) && [2, 3, 6, 7].includes(c + dc))) ring.push(P(id++, "it", "6", r + dr, c + dc));
      const pieces = [P(1, "us", "3", r, c), ...ring, IT].filter((p, i, a) => a.findIndex((q) => q.r === p.r && q.c === p.c) === i);
      const g = game(pieces);
      const res = doAct(g, "blast", 1);
      const e = res.events.find((x) => x.kind === "blast");
      if (e?.kind !== "blast") throw new Error("no blast");
      expect(e.shown.map((s) => s.id).sort((a, b) => a - b)).toEqual(ring.map((p) => p.id));
    }
  });
  it("does not wrap across rows", () => {
    const g = game([P(1, "us", "3", 3, 9), P(2, "it", "6", 4, 0), P(3, "it", "6", 3, 0), P(4, "it", "6", 2, 0), IT]);
    const e = doAct(g, "blast", 1).events.find((x) => x.kind === "blast");
    if (e?.kind !== "blast") throw new Error("no blast");
    expect(e.shown).toEqual([]);
  });
  it("shows a dug-in Major as a Landmine and a switched 10 as a Spy", () => {
    const g = game([P(1, "us", "3", 5, 5), P(2, "it", "7", 5, 4), P(3, "it", "10", 4, 5), IT], { changed: { 2: "dug", 3: "spy" } });
    const e = doAct(g, "blast", 1).events.find((x) => x.kind === "blast");
    if (e?.kind !== "blast") throw new Error("no blast");
    expect(e.shown.map((s) => [s.id, s.rank]).sort()).toEqual([[2, "B"], [3, "1"]]);
  });
  it("is refused for anything but a live Engineer of the side to move", () => {
    const g = game([P(1, "us", "4", 5, 5), P(2, "it", "3", 1, 1), IT]);
    expect(refused(act(g, { kind: "blast", id: 1, at: at(g) }))).toBe("illegal_move");
    expect(refused(act(g, { kind: "blast", id: 2, at: at(g) }))).toBe("not_your_turn");
    expect(refused(act(g, { kind: "blast", id: 55, at: at(g) }))).toBe("no_such_piece");
  });
});

describe("Rescue", () => {
  const base = (truck: Partial<Piece> = {}, over: Partial<Game> = {}) => game([P(1, "us", "8", 7, 2), P(2, "us", "F", 9, 8, truck), P(3, "us", "5", 9, 0), IT], over);
  it("removes the Colonel and puts the Truck on its square, face up, with fuel as it was", () => {
    for (const fuel of [0, 2, 3]) {
      const g = base({ fuel, trail: ["9,8", "9,7", "9,8", "9,7"] });
      const r = doAct(g, "rescue", 1);
      expect(r.events.find((e) => e.kind === "rescue")).toMatchObject({ kind: "rescue", colonel: 1, truck: 2, from: { r: 9, c: 8 }, to: { r: 7, c: 2 } });
      const truck = r.game.pieces.find((p) => p.id === 2)!;
      expect(truck).toMatchObject({ r: 7, c: 2, fuel, known: true, trail: ["7,2"] });
      expect(sq(r.game, 1)).toBe("gone");
      expect(r.game.turn).toBe("it");
    }
  });
  it("a Truck with no fuel can be rescued but still can't drive", () => {
    const r = doAct(base({ fuel: 3 }), "rescue", 1);
    const g = { ...r.game, turn: "us" as const, turnNo: r.game.turnNo + 1 };
    expect(reach(g, 2)).toEqual([]);
  });
  it("costs no fuel and doesn't count as a Truck move", () => {
    const r = doAct(base({ fuel: 1 }, { turnNo: 4, truckTurn: { us: 2, it: -9 } }), "rescue", 1);
    expect(r.game.truckTurn.us).toBe(2);
    expect(r.game.pieces.find((p) => p.id === 2)!.fuel).toBe(1);
    const fresh = doAct(base({}, { turnNo: 4 }), "rescue", 1);
    expect(fresh.game.truckTurn.us).toBe(-9);
  });
  it("works even when the Truck moved on the turn before (a move would be refused)", () => {
    const g = base({}, { turnNo: 4, truckTurn: { us: 2, it: -9 } });
    expect(reach(g, 2)).toEqual([]);
    expect(act(g, { kind: "rescue", id: 1, at: at(g) }).ok).toBe(true);
  });
  it("works for a Truck that is already Spotted", () => {
    const r = doAct(base({ known: true, fuel: 3 }), "rescue", 1);
    expect(r.game.pieces.find((p) => p.id === 2)).toMatchObject({ r: 7, c: 2, known: true });
  });
  it("works with the Colonel next to the Truck", () => {
    const g = game([P(1, "us", "8", 9, 4), P(2, "us", "F", 9, 5), IT]);
    const r = doAct(g, "rescue", 1);
    expect(r.game.pieces.find((p) => p.id === 2)).toMatchObject({ r: 9, c: 4 });
  });
  it("sends the Truck onto a depot without claiming it", () => {
    const g = game([P(1, "us", "8", 1, 5), P(2, "us", "F", 9, 8), IT]);
    const r = doAct(g, "rescue", 1);
    expect(r.events.some((e) => e.kind === "raid")).toBe(false);
    expect(r.game.twoStep.us).toBe(0);
    expect(r.game.depots.find((d) => d.raider === "us")!.claimed).toBe(false);
  });
  it("is followed by a storm that can move the rescued Truck", () => {
    const g = base({}, { turnNo: 0, stormAt: 1, stormDone: false, stormSeed: 5 });
    const r = doAct({ ...g, pieces: [...g.pieces, P(4, "us", "6", 7, 3)] }, "rescue", 1);
    const kinds = r.events.map((e) => e.kind);
    expect(kinds.indexOf("rescue")).toBeLessThan(kinds.indexOf("turn"));
    expect(kinds).toContain("storm");
    const truck = r.game.pieces.find((p) => p.id === 2)!;
    expect(truck.trail).toEqual([`${truck.r},${truck.c}`]);
  });
  it("is refused for anything but a live Colonel", () => {
    const g = base();
    expect(refused(act(g, { kind: "rescue", id: 3, at: at(g) }))).toBe("illegal_move");
  });
});

describe("Dig in", () => {
  const g0 = () => game([P(1, "us", "7", 7, 0), P(2, "us", "7", 7, 1), P(3, "us", "6", 8, 0), IT]);
  it("turns a Major into a Landmine for good and passes the turn, as a missed turn that is not a move", () => {
    const r = doAct(g0(), "dig_in", 1);
    expect(r.game.changed).toEqual({ 1: "dug" });
    expect(r.game.timeouts).toEqual({ us: 1, it: 0 });
    expect(rankOf(r.game, r.game.pieces.find((p) => p.id === 1)!)).toBe("B");
    expect(r.game.turn).toBe("it");
    expect(r.game.moves).toBe(0);
  });
  it("a face-down Major digs in secretly: no dug_in event, only the pass every pass makes", () => {
    const r = doAct(g0(), "dig_in", 1);
    expect(r.events.map((x) => x.kind)).toEqual(["pass", "turn"]);
  });
  it("a face-up Major digs in in the open and the event names it (F1)", () => {
    const g = game([P(1, "us", "7", 7, 0, { known: true }), IT]);
    const e = doAct(g, "dig_in", 1).events.find((x) => x.kind === "dug_in");
    expect(e).toMatchObject({ kind: "dug_in", army: "us", id: 1 });
  });
  it("never moves again, and beats any attacker like a Landmine", () => {
    const d = { ...doAct(g0(), "dig_in", 1).game };
    expect(reach({ ...d, turn: "us" }, 1)).toEqual([]);
    const g = game([P(1, "us", "7", 7, 0), P(2, "it", "10", 6, 0), P(5, "us", "2", 9, 9)], { turn: "it", changed: { 1: "dug" } });
    const r = go(g, 2, 7, 0);
    expect(r.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "mine", flash: [1] });
    expect(sq(r.game, 2)).toBe("gone");
    expect(r.game.pieces.find((p) => p.id === 1)!.known).toBe(true);
  });
  it("drifts in the Dust Storm like any Landmine (F4)", () => {
    const g = game([P(1, "us", "7", 7, 0), P(2, "us", "6", 7, 1), IT], { changed: { 1: "dug" } });
    let moved = 0;
    for (let seed = 1; seed < 30; seed++) {
      const s = storm({ ...g, stormSeed: seed });
      if (s.event?.kind === "storm" && s.event.shifts.some((x) => x.id === 1)) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
  it("a piece that is not a live undug Major makes a plain pass, never a refusal", () => {
    const g = g0();
    for (const id of [3, 77, 90]) {
      const r = doAct(g, "dig_in", id);
      expect(r.game.changed).toEqual({});
      expect(r.game.timeouts.us).toBe(1);
    }
    const dug = game([P(1, "us", "7", 7, 0), IT], { changed: { 1: "dug" } });
    expect(doAct(dug, "dig_in", 1).game.timeouts.us).toBe(1);
  });
  it("is refused inside a Two-Step Turn", () => {
    const g = { ...g0(), twoStep: { us: 1, it: 0 } };
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    expect(refused(act(s.game, { kind: "dig_in", id: 1, at: T0 + 2 }))).toBe("illegal_move");
    expect(refused(act(s.game, { kind: "blast", id: 1, at: T0 + 2 }))).toBe("illegal_move");
    expect(refused(act(s.game, { kind: "rescue", id: 1, at: T0 + 2 }))).toBe("illegal_move");
  });
});

describe("Become a Spy", () => {
  const ten = () => [P(1, "us", "10", 6, 0), P(2, "it", "10", 5, 0), P(3, "us", "4", 9, 9), IT];
  it("a switched General of the Army beats the enemy 10 it attacks, in the same turn", () => {
    const r = go(game(ten()), 1, 5, 0, true);
    expect(r.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win", att: 1, def: 2 });
    expect(r.game.changed).toEqual({ 1: "spy" });
    expect(sq(r.game, 2)).toBe("gone");
  });
  it("loses to a 10 that attacks it, and ties a Spy and another switched 10", () => {
    const lose = go(game([P(1, "us", "10", 6, 0), P(2, "it", "10", 5, 0), IT], { turn: "it", changed: { 1: "spy" } }), 2, 6, 0);
    expect(lose.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win", att: 2 });
    expect(sq(lose.game, 1)).toBe("gone");
    const spy = go(game([P(1, "us", "10", 6, 0), P(2, "it", "1", 5, 0), IT], { changed: { 1: "spy" } }), 1, 5, 0);
    expect(spy.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "tie" });
    const two = go(game([P(1, "us", "10", 6, 0), P(2, "it", "10", 5, 0), IT], { changed: { 1: "spy", 2: "spy" } }), 1, 5, 0);
    expect(two.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "tie" });
  });
  it("is free: a switch goes with a move, a Blast, a Rescue or a Dig in", () => {
    const g = game([P(1, "us", "10", 6, 0), P(2, "us", "3", 7, 5), P(3, "us", "8", 7, 7), P(4, "us", "F", 9, 9), P(5, "us", "7", 8, 8), IT]);
    expect(doAct(g, "blast", 2, true).game.changed).toEqual({ 1: "spy" });
    expect(doAct(g, "rescue", 3, true).game.changed).toEqual({ 1: "spy" });
    expect(doAct(g, "dig_in", 5, true).game.changed).toEqual({ 1: "spy", 5: "dug" });
    expect(go(g, 1, 5, 0, true).game.changed).toEqual({ 1: "spy" });
  });
  it("is secret on a face-down 10 and public, with a switched event, on a face-up one (F1)", () => {
    const down = go(game([P(1, "us", "10", 6, 0), IT]), 1, 5, 0, true);
    expect(down.events.some((e) => e.kind === "switched")).toBe(false);
    const up = go(game([P(1, "us", "10", 6, 0, { known: true }), IT]), 1, 5, 0, true);
    expect(up.events.find((e) => e.kind === "switched")).toMatchObject({ kind: "switched", id: 1 });
    expect(up.events.findIndex((e) => e.kind === "switched")).toBeLessThan(up.events.findIndex((e) => e.kind === "move"));
  });
  it("an invalid switch does nothing: no 10, a dead 10, or one already switched", () => {
    const none = go(game([P(3, "us", "4", 9, 9), IT]), 3, 8, 8, true);
    expect(none.game.changed).toEqual({});
    const twice = go(game([P(1, "us", "10", 6, 0), IT], { changed: { 1: "spy" } }), 1, 5, 0, true);
    expect(twice.events.some((e) => e.kind === "switched")).toBe(false);
    expect(twice.game.changed).toEqual({ 1: "spy" });
  });
  it("is not applied when the action itself is refused", () => {
    const g = game(ten());
    const bad = move(g, { id: 3, to: { r: 3, c: 9 }, at: at(g), switch: true });
    expect(bad).toEqual({ ok: false, reason: "illegal_move" });
    const bad2 = act(g, { kind: "blast", id: 3, at: at(g), switch: true });
    expect(bad2.ok).toBe(false);
  });
  it("the switch is remembered when the 10 dies in the same action", () => {
    const g = game([P(1, "us", "10", 6, 0), P(2, "it", "7", 5, 0), IT]);
    const r = go(g, 1, 5, 0, true);
    expect(r.events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "lose" });
    expect(sq(r.game, 1)).toBe("gone");
    expect(r.game.changed).toEqual({ 1: "spy" });
  });
  it("is not carried by a timeout", () => {
    const g = game(ten());
    const t = timeout(g, g.deadline + 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game.changed).toEqual({});
  });
});

describe("endings and counting", () => {
  it("has_action counts a boxed-in Engineer's Blast, has_step does not", () => {
    const g = game([P(1, "us", "3", 9, 0), P(2, "us", "B", 8, 0), P(3, "us", "B", 9, 1), P(4, "us", "B", 8, 1), IT]);
    expect(hasStep(g, "us")).toBe(false);
    expect(hasAction(g, "us")).toBe(true);
    const mines = game([P(2, "us", "B", 8, 0), P(3, "us", "F", 9, 1, { fuel: 3 }), IT]);
    expect(hasAction(mines, "us")).toBe(false);
    const major = game([P(2, "us", "7", 8, 0), P(3, "us", "B", 9, 0), P(4, "us", "B", 9, 1), P(5, "us", "B", 8, 1), IT]);
    expect(hasAction(major, "us")).toBe(true);
    expect(hasAction({ ...major, changed: { 2: "dug" } }, "us")).toBe(false);
    const colonel = game([P(2, "us", "8", 8, 0), P(3, "us", "B", 9, 0), P(4, "us", "B", 9, 1), P(5, "us", "B", 8, 1), P(6, "us", "F", 7, 7), IT]);
    expect(hasAction(colonel, "us")).toBe(true);
  });
  it("the Match does not end 'stuck' while a side still has a power, but does once it has nothing", () => {
    const alive = game([P(1, "us", "2", 6, 0), P(5, "it", "3", 0, 0), P(6, "it", "B", 1, 0), P(7, "it", "B", 0, 1), P(8, "it", "B", 1, 1)]);
    const r = go(alive, 1, 5, 0);
    expect(r.game.winner).toBeNull();
    expect(r.game.turn).toBe("it");
    const dead = game([P(1, "us", "2", 6, 0), P(6, "it", "B", 1, 0), P(7, "it", "B", 0, 1)]);
    expect(go(dead, 1, 5, 0).game).toMatchObject({ winner: "us", reason: "stuck" });
  });
  it("a Two-Step Turn ends early when no step is left, even if a Blast still is", () => {
    const g = game([P(1, "us", "F", 9, 5), P(2, "us", "3", 9, 0), P(3, "us", "B", 8, 0), P(4, "us", "B", 9, 1), P(5, "us", "B", 8, 1), IT], { twoStep: { us: 1, it: 0 } });
    const s = startTwoStep(g, T0 + 1);
    if (!s.ok) throw new Error(s.reason);
    const r = go(s.game, 1, 8, 5);
    expect(r.game.turn).toBe("it");
  });
  it("a power resets the missed-turn count and counts toward the move cap", () => {
    const g = game([P(1, "us", "3", 9, 0), IT], { timeouts: { us: 2, it: 0 }, moves: MOVE_CAP - 1 });
    const r = doAct(g, "blast", 1);
    expect(r.game.timeouts.us).toBe(0);
    expect(r.game).toMatchObject({ moves: MOVE_CAP, reason: "cap" });
    expect(r.events.at(-1)).toMatchObject({ kind: "end", reason: "cap" });
  });
  it("the power's next deadline counts from the action like a move's", () => {
    const g = game([P(1, "us", "3", 9, 0), P(2, "it", "F", 0, 5), IT]);
    const r = act(g, { kind: "blast", id: 1, at: T0 + 2000 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.game.deadline).toBe(T0 + 2000 + TURN_MS);
  });
  it("the cap tiebreak counts ranks as they are: a dug-in Major is 0, a switched 10 is 1", () => {
    const base = [P(1, "us", "7", 9, 0), P(2, "it", "3", 0, 9)];
    const plain = timeout(game(base), T0 + CAP_MS + 1);
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.game.winner).toBe("us");
    const dug = timeout(game(base, { changed: { 1: "dug" } }), T0 + CAP_MS + 1);
    if (!dug.ok) throw new Error(dug.reason);
    expect(dug.game.winner).toBe("it");
    const ten = [P(1, "us", "10", 9, 0), P(2, "it", "2", 0, 9)];
    const sw = timeout(game(ten, { changed: { 1: "spy" } }), T0 + CAP_MS + 1);
    if (!sw.ok) throw new Error(sw.reason);
    expect(sw.game.winner).toBe("it");
  });
  it("a power is refused after the Match or the clock is over, like a move", () => {
    const g = game([P(1, "us", "3", 9, 0), IT]);
    expect(refused(act({ ...g, winner: "it", reason: "truck" }, { kind: "blast", id: 1, at: at(g) }))).toBe("match_over");
    expect(refused(act(g, { kind: "blast", id: 1, at: T0 + TURN_MS + 1 }))).toBe("turn_expired");
    expect(refused(act(g, { kind: "blast", id: 1, at: T0 + CAP_MS + 1 }))).toBe("cap_passed");
  });
  it("the end reveal keeps the changed set, dead pieces included, and the refusal set stays closed", () => {
    const g = game([P(1, "us", "10", 6, 0), P(2, "it", "7", 5, 0), P(3, "it", "F", 3, 0), IT]);
    const lost = go(g, 1, 5, 0, true).game;
    expect(lost.changed).toEqual({ 1: "spy" });
    expect([...REFUSALS]).toHaveLength(8);
  });
  it("determinism: the same actions give the same game and events", () => {
    const run = () => {
      const g = game([P(1, "us", "3", 5, 5), P(2, "it", "6", 5, 4), P(3, "it", "F", 0, 5)]);
      return doAct(g, "blast", 1);
    };
    expect(run()).toEqual(run());
  });
});
