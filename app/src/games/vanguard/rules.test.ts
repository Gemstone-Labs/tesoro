import { describe, expect, it } from "vitest";
import { CAP_MS, CHAIN_CLOCK, RULES_VERSION, OPENING_GRACE_MS, PRACTICE_CLOCK, DEPOTS, ROSTER, START_SQUARES, fight, startGame, startIndex, isWadi, move, newGame, placeArmy, seeded, REFUSALS, startTwoStep, storm, targets, timeout, TURN_MS, type Game, type Piece, type Rank } from "./rules";

const T0 = 1_000_000;

const P = (id: number, army: "us" | "it", rank: Rank, r: number, c: number, extra: Partial<Piece> = {}): Piece => ({ id, army, rank, r, c, known: false, fuel: 0, trail: [`${r},${c}`], ...extra });

/** A bare game with only the given pieces. */
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

/** Make a move that must be accepted, one second before the turn's deadline. */
function go(g: Game, id: number, r: number, c: number) {
  const res = move(g, { id, to: { r, c }, at: g.deadline - 1000 });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res;
}

describe("setup", () => {
  it("drops the full roster in each start zone with the spawn limits", () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const army of ["us", "it"] as const) {
        const ps = placeArmy(army, seeded(seed));
        expect(ps).toHaveLength(20);
        for (const [rank, n] of ROSTER) expect(ps.filter((p) => p.rank === rank)).toHaveLength(n);
        const front = army === "us" ? 7 : 2;
        const dep = DEPOTS.find((d) => d.raider !== army)!;
        for (const p of ps) {
          expect(army === "us" ? p.r >= 7 : p.r <= 2).toBe(true);
          expect(p.r === dep.r && p.c === dep.c).toBe(false);
          if (p.rank === "B" || p.rank === "F") expect(p.r).not.toBe(front);
          if (p.rank === "B") expect(Math.abs(p.r - dep.r) + Math.abs(p.c - dep.c)).not.toBe(1);
        }
        expect(new Set(ps.map((p) => `${p.r},${p.c}`)).size).toBe(20);
      }
    }
  });
  it("new games have 40 pieces and the US moves first", () => {
    const g = newGame(seeded(3), T0);
    expect(g.pieces).toHaveLength(40);
    expect(g.turn).toBe("us");
  });
});

describe("combat", () => {
  it("follows the manual", () => {
    expect(fight("5", "4")).toBe("win");
    expect(fight("4", "5")).toBe("lose");
    expect(fight("6", "6")).toBe("tie");
    expect(fight("1", "10")).toBe("win");
    expect(fight("10", "1")).toBe("lose"); // v6: the Spy beats the 10 both ways (founder 2026-10-22)
    expect(fight("10", "1", 5)).toBe("win");
    expect(fight("3", "B")).toBe("mine"); // v6: the Engineer no longer defuses (see powers.test.ts for v5)
    expect(fight("10", "B")).toBe("mine");
    expect(fight("2", "F")).toBe("truck");
  });
  it("a lost attack flashes only the attacker; the winning defender stays hidden", () => {
    const g = game([P(1, "us", "3", 6, 0), P(2, "it", "7", 5, 0)]);
    const { game: g2, events } = go(g, 1, 5, 0);
    const a = events.find((e) => e.kind === "attack");
    expect(a).toMatchObject({ outcome: "lose", flash: [1] });
    expect(g2.pieces.map((p) => p.id)).toEqual([2]);
  });
  it("a 10 that attacks a Spy dies, and the Spy stays where it is", () => {
    const g = game([P(1, "us", "10", 6, 0), P(2, "it", "1", 5, 0), P(3, "us", "5", 9, 9), P(4, "it", "5", 0, 9)]);
    const { game: g2, events } = go(g, 1, 5, 0);
    expect(events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "lose", flash: [1] });
    expect(g2.pieces.find((p) => p.id === 2)).toMatchObject({ r: 5, c: 0, known: false });
    expect(g2.pieces.some((p) => p.id === 1)).toBe(false);
  });
  it("a win flashes the beaten piece and moves in", () => {
    const g = game([P(1, "us", "8", 6, 0), P(2, "it", "7", 5, 0), P(3, "it", "5", 0, 9)]);
    const { game: g2, events } = go(g, 1, 5, 0);
    expect(events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win", flash: [2] });
    expect(g2.pieces.find((p) => p.id === 1)).toMatchObject({ r: 5, c: 0 });
  });
  it("a landmine that goes off survives and is revealed for good", () => {
    const g = game([P(1, "us", "9", 6, 0), P(2, "it", "B", 5, 0), P(4, "us", "5", 9, 9), P(3, "it", "5", 0, 9)]);
    const { game: g2, events } = go(g, 1, 5, 0);
    // the attacker it killed is shown too, like any piece that dies attacking (founder 2026-10-22)
    expect(events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "mine", flash: [1, 2] });
    expect(g2.pieces.map((p) => p.id).sort()).toEqual([2, 3, 4]);
    expect(g2.pieces.find((p) => p.id === 2)!.known).toBe(true);
  });
  it("capturing the Truck ends the Match", () => {
    const g = game([P(1, "us", "2", 9, 0), P(2, "it", "F", 3, 0)]);
    const { game: g2 } = go(g, 1, 3, 0);
    expect(g2.winner).toBe("us");
    expect(g2.reason).toBe("truck");
  });
});

describe("movement", () => {
  it("Recon runs in a straight line, stopping at pieces and wadis", () => {
    const g = game([P(1, "us", "2", 9, 2), P(2, "it", "5", 0, 9)]);
    const t = targets(g, g.pieces[0]);
    expect(t.filter((s) => s.c === 2).map((s) => s.r).sort((a, b) => a - b)).toEqual([6, 7, 8]); // wadi at rows 4-5
    expect(t.filter((s) => s.r === 9)).toHaveLength(9);
  });
  it("Landmines never move; wadis are closed", () => {
    expect(isWadi(4, 2)).toBe(true);
    const g = game([P(1, "us", "B", 9, 0), P(2, "it", "5", 0, 9)]);
    expect(targets(g, g.pieces[0])).toEqual([]);
  });
  it("stops shuttling after three back-and-forth moves", () => {
    let g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)]);
    const bot = (x: Game) => {
      const it = x.pieces.find((p) => p.id === 2)!;
      const t = targets(x, it)[0];
      return go(x, 2, t.r, t.c).game;
    };
    g = bot(go(g, 1, 8, 0).game);
    g = bot(go(g, 1, 9, 0).game);
    g = bot(go(g, 1, 8, 0).game);
    const me = g.pieces.find((p) => p.id === 1)!;
    expect(targets(g, me).some((s) => s.r === 9 && s.c === 0)).toBe(false);
  });
  it("the Truck: never two own turns in a row, three moves, then Spotted and stuck", () => {
    let g = game([P(1, "us", "F", 9, 5), P(3, "us", "5", 9, 0), P(2, "it", "4", 0, 9), P(4, "it", "4", 0, 0)]);
    const pass = (x: Game) => {
      const it = x.pieces.find((p) => p.army === "it" && targets(x, p).length)!;
      const t = targets(x, it)[0];
      return go(x, it.id, t.r, t.c).game;
    };
    g = pass(go(g, 1, 8, 5).game);
    expect(targets(g, g.pieces.find((p) => p.id === 1)!)).toEqual([]); // transmission
    g = pass(go(g, 3, 8, 0).game);
    g = pass(go(g, 1, 7, 5).game);
    g = pass(go(g, 3, 9, 0).game);
    const r = go(g, 1, 6, 5);
    expect(r.events.some((e) => e.kind === "spotted")).toBe(true);
    const truck = r.game.pieces.find((p) => p.id === 1)!;
    expect(truck.known).toBe(true);
    expect(targets({ ...r.game, turn: "us", turnNo: r.game.turnNo + 1 }, truck)).toEqual([]);
  });
});

describe("depots", () => {
  it("a one-square step onto the enemy depot banks a Two-Step Turn, once", () => {
    const g = game([P(1, "us", "5", 2, 5), P(2, "it", "4", 9, 9)]);
    const r = go(g, 1, 1, 5);
    expect(r.events.some((e) => e.kind === "raid")).toBe(true);
    expect(r.game.twoStep.us).toBe(1);
    expect(r.game.depots.find((d) => d.raider === "us")!.claimed).toBe(true);
  });
  it("a Recon run onto the depot does not claim it", () => {
    const g = game([P(1, "us", "2", 3, 5), P(2, "it", "4", 9, 9)]);
    const r = go(g, 1, 1, 5);
    expect(r.game.twoStep.us).toBe(0);
  });
  it("a Two-Step Turn gives two single steps", () => {
    const start = startTwoStep(game([P(1, "us", "2", 9, 0), P(2, "it", "4", 0, 9)], { twoStep: { us: 1, it: 0 } }), T0 + 100);
    if (!start.ok) throw new Error(start.reason);
    const g = start.game;
    expect(g.stepsLeft).toBe(2);
    expect(targets(g, g.pieces[0]).every((s) => Math.abs(s.r - 9) + Math.abs(s.c) === 1)).toBe(true);
    const a = go(g, 1, 8, 0).game;
    expect(a.turn).toBe("us");
    const b = go(a, 1, 7, 0).game;
    expect(b.turn).toBe("it");
  });
});

describe("clock and storm", () => {
  it("three timeouts in a row lose the Match", () => {
    let g = game([P(1, "us", "5", 9, 0), P(2, "it", "3", 0, 9)]);
    const expire = (x: Game) => {
      const r = timeout(x, x.deadline + 1);
      if (!r.ok) throw new Error(r.reason);
      return r.game;
    };
    for (let i = 0; i < 2; i++) {
      g = expire(g); // US
      g = go(g, 2, g.pieces[1].r + 1, 9).game; // Italy moves
    }
    expect(expire(g)).toMatchObject({ winner: "it", reason: "timeouts" });
  });
  it("the Dust Storm shifts one line by a square, blocked pieces stay", () => {
    const g = game([P(1, "us", "5", 7, 0), P(2, "us", "4", 7, 1), P(3, "us", "6", 7, 9), P(4, "it", "4", 0, 5)], { stormSeed: 11 });
    const { game: g2, event } = storm(g);
    expect(event?.kind).toBe("storm");
    if (event?.kind !== "storm") return;
    for (const s of event.shifts) expect(Math.abs(s.to.r - s.from.r) + Math.abs(s.to.c - s.from.c)).toBe(1);
    expect(new Set(g2.pieces.map((p) => `${p.r},${p.c}`)).size).toBe(g2.pieces.length);
  });
});

describe("piece numbers", () => {
  it("a piece's number is the index of its start square, whatever its rank", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = newGame(seeded(seed), T0);
      expect(new Set(g.pieces.map((p) => p.id)).size).toBe(40);
      for (const p of g.pieces) {
        expect(p.id).toBe(startIndex(p.r, p.c));
        expect(START_SQUARES[p.id]).toEqual({ r: p.r, c: p.c });
      }
      expect(g.pieces.map((p) => p.id)).toEqual([...g.pieces.map((p) => p.id)].sort((a, b) => a - b));
    }
  });
  it("numbers say nothing about rank: Landmines and Trucks land below and above the rest", () => {
    let mineAboveSome = 0;
    let mineBelowSome = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const us = newGame(seeded(seed), T0).pieces.filter((p) => p.army === "us");
      const special = us.filter((p) => p.rank === "B" || p.rank === "F").map((p) => p.id);
      const rest = us.filter((p) => p.rank !== "B" && p.rank !== "F").map((p) => p.id);
      if (Math.max(...special) > Math.min(...rest)) mineAboveSome++;
      if (Math.min(...special) < Math.max(...rest)) mineBelowSome++;
    }
    expect(mineAboveSome).toBeGreaterThan(190);
    expect(mineBelowSome).toBeGreaterThan(190);
  });
  it("a layout given explicitly gets numbers from its squares", () => {
    const g = startGame(
      [
        { army: "us", rank: "F", r: 9, c: 0 },
        { army: "it", rank: "10", r: 0, c: 3 },
      ],
      { startedAt: T0, stormAt: 12, stormSeed: 5, first: "us" },
    );
    expect(g.pieces.map((p) => [p.id, p.rank])).toEqual([[startIndex(0, 3), "10"], [startIndex(9, 0), "F"]]);
    expect(g).toMatchObject({ startedAt: T0, deadline: T0 + TURN_MS, stormAt: 12, stormSeed: 5, turn: "us" });
  });
});

describe("turn clock", () => {
  it("the chain clock adds one second of grace to every deadline and ten to the opening turn, Practice adds none", () => {
    expect(PRACTICE_CLOCK).toEqual({ turnMs: 10_000, graceMs: 0, openingGraceMs: 0, resolveSlackMs: 0 });
    expect(CHAIN_CLOCK).toEqual({ turnMs: 10_000, graceMs: 1000, openingGraceMs: OPENING_GRACE_MS, resolveSlackMs: 2000 });
    expect(OPENING_GRACE_MS).toBe(10_000);
    const layout = [{ army: "us" as const, rank: "5" as const, r: 9, c: 0 }, { army: "it" as const, rank: "4" as const, r: 0, c: 9 }];
    const g = startGame(layout, { startedAt: T0, stormAt: 99, stormSeed: 1, first: "us", clock: CHAIN_CLOCK });
    expect(g.deadline).toBe(T0 + 21000);
    expect(move(g, { id: startIndex(9, 0), to: { r: 8, c: 0 }, at: T0 + 21000 }).ok).toBe(true);
    expect(move(g, { id: startIndex(9, 0), to: { r: 8, c: 0 }, at: T0 + 21001 })).toEqual({ ok: false, reason: "turn_expired" });
    const m = move(g, { id: startIndex(9, 0), to: { r: 8, c: 0 }, at: T0 + 2000 });
    if (!m.ok) throw new Error(m.reason);
    expect(m.game.deadline).toBe(T0 + 13000);
    expect(timeout(g, T0 + 21000)).toEqual({ ok: false, reason: "turn_not_expired" });
    const t = timeout(g, T0 + 22000);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game.deadline).toBe(T0 + 33000);
    expect(startGame(layout, { startedAt: T0, stormAt: 99, stormSeed: 1, first: "us" }).deadline).toBe(T0 + 10_000);
  });
  it("on the chain the next deadline counts from the resolve, but a held-back resolve gains at most the slack", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)], { clock: { ...PRACTICE_CLOCK, resolveSlackMs: 2000 } });
    const resolvedAfter = (ms: number) => {
      const m = move(g, { id: 1, to: { r: 8, c: 0 }, at: T0 + 2000, resolvedAt: T0 + 2000 + ms });
      if (!m.ok) throw new Error(m.reason);
      return m.game.deadline;
    };
    expect(resolvedAfter(0)).toBe(T0 + 2000 + TURN_MS);
    expect(resolvedAfter(1000)).toBe(T0 + 3000 + TURN_MS);
    expect(resolvedAfter(2000)).toBe(T0 + 4000 + TURN_MS);
    expect(resolvedAfter(7000)).toBe(T0 + 4000 + TURN_MS);
    const late = timeout(g, g.deadline + 1, g.deadline + 4000);
    if (!late.ok) throw new Error(late.reason);
    expect(late.game.deadline).toBe(g.deadline + 1 + 2000 + TURN_MS);
  });
  it("a move at the deadline is accepted, one millisecond later is refused", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)]);
    expect(move(g, { id: 1, to: { r: 8, c: 0 }, at: g.deadline }).ok).toBe(true);
    expect(move(g, { id: 1, to: { r: 8, c: 0 }, at: g.deadline + 1 })).toEqual({ ok: false, reason: "turn_expired" });
  });
  it("every move gives the next turn a fresh deadline, each Two-Step step included", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)], { twoStep: { us: 1, it: 0 } });
    const started = startTwoStep(g, T0 + 1000);
    if (!started.ok) throw new Error(started.reason);
    expect(started.game.deadline).toBe(g.deadline);
    const a = move(started.game, { id: 1, to: { r: 8, c: 0 }, at: T0 + 2000 });
    if (!a.ok) throw new Error(a.reason);
    expect(a.game.deadline).toBe(T0 + 2000 + TURN_MS);
    const b = move(a.game, { id: 1, to: { r: 7, c: 0 }, at: T0 + 3000 });
    if (!b.ok) throw new Error(b.reason);
    expect(b.game).toMatchObject({ turn: "it", deadline: T0 + 3000 + TURN_MS });
  });
  it("a timeout is only possible after the deadline, and starts the other side's clock", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)]);
    expect(timeout(g, g.deadline)).toEqual({ ok: false, reason: "turn_not_expired" });
    const t = timeout(g, g.deadline + 250);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game).toMatchObject({ turn: "it", deadline: g.deadline + 250 + TURN_MS });
    expect(t.game.timeouts.us).toBe(1);
  });
});

describe("time cap", () => {
  const pieces = () => [P(1, "us", "9", 9, 0), P(2, "it", "4", 0, 9), P(3, "it", "2", 0, 8)];
  it("a move is still accepted at the cap and refused after it", () => {
    const g = game(pieces(), { deadline: T0 + CAP_MS + 5000 });
    expect(move(g, { id: 1, to: { r: 8, c: 0 }, at: T0 + CAP_MS }).ok).toBe(true);
    expect(move(g, { id: 1, to: { r: 8, c: 0 }, at: T0 + CAP_MS + 1 })).toEqual({ ok: false, reason: "cap_passed" });
  });
  it("past the cap a timeout ends the Match on the tiebreak, even before the turn deadline", () => {
    const g = game(pieces(), { deadline: T0 + CAP_MS + 5000 });
    const t = timeout(g, T0 + CAP_MS + 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game).toMatchObject({ winner: "us", reason: "cap" });
    expect(t.game.timeouts.us).toBe(0);
    expect(t.events.at(-1)).toMatchObject({ kind: "end", winner: "us", reason: "cap" });
  });
  it("equal ranks and equal pieces draw", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "5", 0, 9)]);
    const t = timeout(g, T0 + CAP_MS + 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game).toMatchObject({ winner: "draw", reason: "cap" });
  });
  it("more pieces break a tie on rank sum", () => {
    const g = game([P(1, "us", "5", 9, 0), P(2, "it", "5", 0, 9), P(3, "it", "B", 0, 8)]);
    const t = timeout(g, T0 + CAP_MS + 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.game.winner).toBe("it");
  });
});

describe("end of Match reveal", () => {
  const hidden = () => [P(1, "us", "2", 9, 0), P(2, "it", "F", 3, 0), P(3, "it", "B", 0, 5), P(4, "us", "7", 9, 9)];
  it("capturing the Truck turns every remaining piece face up", () => {
    const r = go(game(hidden()), 1, 3, 0);
    expect(r.game.pieces.every((p) => p.known)).toBe(true);
  });
  it("three timeouts, the cap and a boxed-in army reveal too", () => {
    const cap = timeout(game(hidden()), T0 + CAP_MS + 1);
    if (!cap.ok) throw new Error(cap.reason);
    expect(cap.game.pieces.every((p) => p.known)).toBe(true);
    const three = timeout(game(hidden(), { timeouts: { us: 2, it: 0 } }), T0 + TURN_MS + 1);
    if (!three.ok) throw new Error(three.reason);
    expect(three.game.pieces.every((p) => p.known)).toBe(true);
    const boxed = go(game([P(1, "us", "5", 9, 0), P(2, "it", "B", 0, 0)]), 1, 8, 0);
    expect(boxed.game).toMatchObject({ winner: "us", reason: "stuck" });
    expect(boxed.game.pieces.every((p) => p.known)).toBe(true);
  });
  it("a running Match keeps hidden pieces hidden", () => {
    const r = go(game(hidden()), 4, 8, 9);
    expect(r.game.winner).toBeNull();
    expect(r.game.pieces.filter((p) => p.army === "it").every((p) => !p.known)).toBe(true);
  });
});

describe("storm line", () => {
  it("is drawn when the storm fires, from the lines that hold two pieces then", () => {
    // before the move row 7 (A, B) and column 0 (A, C) hold two; after A steps down only column 0 does
    for (let seed = 1; seed <= 30; seed++) {
      const g = game([P(1, "us", "5", 7, 0), P(2, "us", "4", 7, 1), P(3, "us", "6", 6, 0), P(4, "it", "7", 0, 5)], { stormAt: 1, stormDone: false, stormSeed: seed });
      const e = go(g, 1, 8, 0).events.find((x) => x.kind === "storm");
      expect(e).toMatchObject({ kind: "storm", axis: "col", index: 0 });
    }
  });
  it("the same seed picks another line when the pieces stand differently at fire time", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = storm(game([P(1, "us", "5", 7, 0), P(2, "us", "4", 7, 1), P(3, "it", "6", 0, 5)], { stormSeed: seed })).event;
      const b = storm(game([P(1, "us", "5", 7, 0), P(2, "us", "4", 6, 0), P(3, "it", "6", 0, 5)], { stormSeed: seed })).event;
      expect(a).toMatchObject({ axis: "row", index: 7 });
      expect(b).toMatchObject({ axis: "col", index: 0 });
    }
  });
  it("is the same for the same seed and the same board", () => {
    const g = game([P(1, "us", "5", 7, 0), P(2, "us", "4", 7, 1), P(3, "it", "6", 0, 5), P(4, "it", "7", 0, 6)], { stormSeed: 99 });
    expect(storm(g)).toEqual(storm(g));
  });
  it("does nothing when no line holds two pieces", () => {
    const g = game([P(1, "us", "5", 7, 0), P(2, "it", "6", 0, 5)], { stormSeed: 3, stormDone: false });
    const s = storm(g);
    expect(s.event).toBeNull();
    expect(s.game.stormDone).toBe(true);
  });
});

describe("events", () => {
  it("carry consecutive sequence numbers across actions", () => {
    let g = game([P(1, "us", "5", 7, 0), P(2, "it", "4", 0, 9)], { stormAt: 1, stormDone: false });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const actor = g.turn === "us" ? 1 : 2;
      const p = g.pieces.find((x) => x.id === actor)!;
      const t = targets(g, p)[0];
      const r = go(g, actor, t.r, t.c);
      seen.push(...r.events.map((e) => e.seq));
      g = r.game;
    }
    expect(seen.length).toBeGreaterThan(4);
    expect(seen).toEqual(seen.map((_, i) => i));
    expect(g.eventSeq).toBe(seen.length);
  });
});

describe("refusals", () => {
  const base = () => game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9), P(3, "us", "B", 9, 5)], { twoStep: { us: 0, it: 0 } });
  const at = T0 + 100;
  const reason = (r: ReturnType<typeof move>) => (r.ok ? "accepted" : r.reason);
  it("match_over", () => {
    const over = { ...base(), winner: "us" as const, reason: "truck" as const };
    expect(reason(move(over, { id: 1, to: { r: 8, c: 0 }, at }))).toBe("match_over");
    expect(reason(timeout(over, at + TURN_MS * 2))).toBe("match_over");
    expect(reason(startTwoStep(over, at))).toBe("match_over");
  });
  it("cap_passed", () => {
    expect(reason(move(base(), { id: 1, to: { r: 8, c: 0 }, at: T0 + CAP_MS + 1 }))).toBe("cap_passed");
    expect(reason(startTwoStep({ ...base(), twoStep: { us: 1, it: 0 } }, T0 + CAP_MS + 1))).toBe("cap_passed");
  });
  it("turn_expired and turn_not_expired", () => {
    expect(reason(move(base(), { id: 1, to: { r: 8, c: 0 }, at: T0 + TURN_MS + 1 }))).toBe("turn_expired");
    expect(reason(startTwoStep({ ...base(), twoStep: { us: 1, it: 0 } }, T0 + TURN_MS + 1))).toBe("turn_expired");
    expect(reason(timeout(base(), at))).toBe("turn_not_expired");
  });
  it("not_your_turn", () => {
    expect(reason(move(base(), { id: 2, to: { r: 1, c: 9 }, at }))).toBe("not_your_turn");
  });
  it("no_such_piece", () => {
    expect(reason(move(base(), { id: 77, to: { r: 8, c: 0 }, at }))).toBe("no_such_piece");
    const afterCapture = go(game([P(1, "us", "8", 6, 0), P(2, "it", "7", 5, 0), P(3, "it", "5", 0, 9)]), 1, 5, 0).game;
    expect(reason(move({ ...afterCapture, turn: "it" }, { id: 2, to: { r: 4, c: 0 }, at }))).toBe("no_such_piece");
  });
  it("illegal_move covers every rule the same way", () => {
    expect(reason(move(base(), { id: 3, to: { r: 8, c: 5 }, at }))).toBe("illegal_move"); // Landmine
    expect(reason(move(base(), { id: 1, to: { r: 7, c: 0 }, at }))).toBe("illegal_move"); // two squares
    expect(reason(move(base(), { id: 1, to: { r: 9, c: 5 }, at }))).toBe("illegal_move"); // own piece
    expect(reason(move(game([P(1, "us", "5", 6, 2), P(2, "it", "4", 0, 9)]), { id: 1, to: { r: 5, c: 2 }, at }))).toBe("illegal_move"); // wadi
    expect(reason(move(base(), { id: 1, to: { r: 10, c: 0 }, at }))).toBe("illegal_move"); // off the board
  });
  it("no_two_step when none is banked, one is running, or a step was made", () => {
    expect(reason(startTwoStep(base(), at))).toBe("no_two_step");
    const banked = { ...base(), twoStep: { us: 2, it: 0 } };
    const running = startTwoStep(banked, at);
    if (!running.ok) throw new Error(running.reason);
    expect(reason(startTwoStep(running.game, at))).toBe("no_two_step");
    expect(reason(startTwoStep({ ...banked, movedThisTurn: [1] }, at))).toBe("no_two_step");
  });
  it("every reason a refusal can carry is in the closed list", () => {
    expect([...REFUSALS].sort()).toEqual(["cap_passed", "illegal_move", "match_over", "no_such_piece", "no_two_step", "not_your_turn", "turn_expired", "turn_not_expired"]);
  });
});

describe("determinism", () => {
  it("the same layout and actions give the same game and events", () => {
    const play = () => {
      let g = newGame(seeded(21), T0);
      const log: unknown[] = [];
      for (let i = 0; i < 30 && !g.winner; i++) {
        const mine = g.pieces.filter((p) => p.army === g.turn).flatMap((p) => targets(g, p).map((t) => ({ p, t })));
        if (!mine.length) break;
        const pick = mine[(i * 7) % mine.length];
        const r = move(g, { id: pick.p.id, to: { r: pick.t.r, c: pick.t.c }, at: g.deadline - 1 });
        if (!r.ok) throw new Error(r.reason);
        log.push(r.events);
        g = r.game;
      }
      return { g, log };
    };
    expect(play()).toEqual(play());
  });
});
