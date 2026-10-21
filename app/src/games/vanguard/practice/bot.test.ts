import { describe, expect, it } from "vitest";
import { DEPOTS, PRACTICE_CLOCK, RULES_VERSION, TURN_MS, newGame, seeded, startTwoStep, timeout, type Game, type GameEvent, type Piece, type Rank } from "../rules";
import { applyBot, botMove, type Policy } from "./bot";

const T0 = 5_000_000;

const P = (id: number, army: "us" | "it", rank: Rank, r: number, c: number, extra: Partial<Piece> = {}): Piece => ({ id, army, rank, r, c, known: false, fuel: 0, trail: [`${r},${c}`], ...extra });
function game(pieces: Piece[], over: Partial<Game> = {}): Game {
  return {
    pieces, depots: DEPOTS.map((d) => ({ ...d })), turn: "us", turnNo: 0, moves: 0, twoStep: { us: 0, it: 0 }, stepsLeft: 1, twoStepActive: false,
    timeouts: { us: 0, it: 0 }, truckTurn: { us: -9, it: -9 }, movedThisTurn: [], startedAt: T0, clock: PRACTICE_CLOCK, deadline: T0 + TURN_MS, stormAt: 999,
    stormSeed: 7, stormDone: true, eventSeq: 0, winner: null, reason: null, version: RULES_VERSION, changed: {}, digs: { us: 0, it: 0 }, ...over,
  };
}
const FAR = P(90, "it", "2", 0, 9);

interface Tally { events: Record<string, number>; jump: number; cross: number; diagonal: number; king: number; switched: number; dug: number; ended: number }

/** Two copies of the bot play a whole Match on the engine; every action the bot picks must be accepted. */
function playOut(seed: number, policies: [Policy, Policy] = ["standard", "standard"], tally?: Tally): Game {
  const rng = seeded(seed);
  let g = newGame(rng, T0);
  for (let i = 0; i < 2000 && !g.winner; i++) {
    const m = botMove(g, rng, policies[g.turn === "us" ? 0 : 1]);
    const at = T0 + i * 1000;
    if (!m) {
      const t = timeout(g, g.deadline + 1);
      if (!t.ok) throw new Error(t.reason);
      g = t.game;
      continue;
    }
    if (m.twoStep) {
      const s = startTwoStep(g, at);
      if (!s.ok) throw new Error(s.reason);
      g = s.game;
    }
    const mover = g.pieces.find((p) => p.id === m.id)!;
    const r = applyBot(g, m, at);
    if (!r.ok) throw new Error(`seed ${seed}: bot action ${m.kind} refused (${r.reason})`);
    if (tally) count(tally, mover, r.events, g);
    g = r.game;
  }
  if (tally) {
    tally.switched += Object.values(g.changed).filter((c) => c === "spy").length;
    tally.dug += Object.values(g.changed).filter((c) => c === "dug").length;
    tally.ended++;
  }
  return g;
}
function count(t: Tally, mover: Piece, events: GameEvent[], before: Game) {
  for (const e of events) t.events[e.kind] = (t.events[e.kind] ?? 0) + 1;
  const e = events.find((x) => x.kind === "move" || x.kind === "attack");
  if (!e || (e.kind !== "move" && e.kind !== "attack")) return;
  const dr = Math.abs(e.to.r - e.from.r);
  const dc = Math.abs(e.to.c - e.from.c);
  const rank = before.changed[mover.id] === "spy" ? "1" : mover.rank;
  if (rank === "5" && Math.max(dr, dc) === 2) t.jump++;
  if (rank === "9" && Math.max(dr, dc) === 3) t.cross++;
  if (rank === "4" && dr && dc) t.diagonal++;
  if (rank === "6" && dr && dc) t.king++;
}

describe("practice bot", () => {
  it("plays whole Matches to an end without a single refused action", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const g = playOut(seed);
      expect(g.winner).not.toBeNull();
      expect(g.pieces.every((p) => p.known)).toBe(true);
    }
  });

  it("uses the powers in seeded runs: Blast, Rescue, Dig in, Jump, wadi crossing, diagonals (a shown 10 is too rare to wait for, see the next test)", () => {
    const t: Tally = { events: {}, jump: 0, cross: 0, diagonal: 0, king: 0, switched: 0, dug: 0, ended: 0 };
    for (let seed = 1; seed <= 150; seed++) playOut(seed, ["standard", "standard"], t);
    expect(t.events.blast).toBeGreaterThan(0);
    expect(t.events.rescue).toBeGreaterThan(0);
    expect(t.events.dug_in ?? 0).toBeGreaterThan(0);
    expect(t.dug).toBeGreaterThan(0);
    expect(t.jump).toBeGreaterThan(0);
    expect(t.cross).toBeGreaterThan(0);
    expect(t.diagonal).toBeGreaterThan(0);
    expect(t.king).toBeGreaterThan(0);
  }, 120_000);

  it("a seeded Match where a Blast shows the enemy 10 ends with the 10 switching to kill it", () => {
    const rng = seeded(5);
    let g = game([P(1, "us", "3", 5, 5), P(2, "it", "10", 4, 5), P(3, "it", "6", 4, 4), P(4, "it", "6", 6, 6), P(5, "us", "10", 3, 5), P(6, "us", "F", 9, 9), P(7, "it", "F", 0, 0)]);
    const blast = botMove(g, rng)!;
    expect(blast.kind).toBe("blast");
    const b = applyBot(g, blast, T0 + 1);
    if (!b.ok) throw new Error(b.reason);
    const pass = timeout(b.game, b.game.deadline + 1);
    if (!pass.ok) throw new Error(pass.reason);
    g = pass.game;
    let switched = false;
    for (let i = 0; i < 12 && !switched && g.pieces.some((p) => p.id === 2); i++) {
      const m = botMove(g, rng)!;
      if (m.kind === "move" && m.switch) switched = true;
      const r = applyBot({ ...g, deadline: T0 + 100_000 + i * 1000 + TURN_MS }, m, T0 + 100_000 + i * 1000);
      if (!r.ok) throw new Error(r.reason);
      const back = timeout(r.game, r.game.deadline + 1);
      g = back.ok ? back.game : r.game;
    }
    expect(switched).toBe(true);
    expect(g.changed[5]).toBe("spy");
    expect(g.pieces.some((p) => p.id === 2)).toBe(false);
    expect(g.pieces.some((p) => p.id === 5)).toBe(true);
  });

  it("never plans a Two-Step Turn unless a one-square step exists, and the move it picks is legal inside it", () => {
    let spent = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = seeded(seed);
      let g = newGame(rng, T0);
      for (let i = 0; i < 300 && !g.winner; i++) {
        const m = botMove(g, rng);
        const at = T0 + i * 1000;
        if (!m) break;
        if (m.twoStep) {
          const s = startTwoStep(g, at);
          if (!s.ok) throw new Error(s.reason);
          g = s.game;
          spent++;
        }
        const r = applyBot(g, m, at);
        expect(r.ok, `seed ${seed} action ${i}`).toBe(true);
        if (!r.ok) return;
        g = r.game;
      }
    }
    expect(spent).toBeGreaterThan(0);
  }, 30_000);

  it("keeps a banked Two-Step Turn when only a jump is left", () => {
    // the Lieutenant is boxed in by its own Landmines: it can jump but cannot step
    const g = game([P(1, "us", "5", 9, 0), P(2, "us", "B", 8, 0), P(3, "us", "B", 9, 1), FAR], { twoStep: { us: 1, it: 0 } });
    const m = botMove(g, seeded(1));
    expect(m).toMatchObject({ kind: "move", twoStep: false });
    expect(applyBot(g, m!, T0 + 1).ok).toBe(true);
  });

  describe("powers", () => {
    it("Blasts when 3 or more hidden enemies are around an Engineer, not with 2 or with shown ones", () => {
      const three = game([P(1, "us", "3", 5, 5), P(2, "it", "6", 5, 4), P(3, "it", "6", 4, 5), P(4, "it", "6", 6, 6), P(5, "us", "F", 9, 9), FAR]);
      expect(botMove(three, seeded(1))).toMatchObject({ kind: "blast", id: 1 });
      const two = game([P(1, "us", "3", 5, 5), P(2, "it", "6", 5, 4), P(3, "it", "6", 4, 5), P(5, "us", "F", 9, 9), FAR]);
      expect(botMove(two, seeded(1))?.kind).toBe("move");
      const shown = game([P(1, "us", "3", 5, 5), P(2, "it", "6", 5, 4, { known: true }), P(3, "it", "6", 4, 5), P(4, "it", "6", 6, 6), P(5, "us", "F", 9, 9), FAR]);
      expect(botMove(shown, seeded(1))?.kind).toBe("move");
    });
    it("Rescues when an enemy stands next to its Truck", () => {
      const g = game([P(1, "us", "8", 6, 0), P(2, "us", "F", 9, 5), P(3, "it", "6", 8, 6), FAR]);
      expect(botMove(g, seeded(1))).toMatchObject({ kind: "rescue", id: 1 });
      const calm = game([P(1, "us", "8", 6, 0), P(2, "us", "F", 9, 5), P(3, "it", "6", 5, 6), FAR]);
      expect(botMove(calm, seeded(1))?.kind).toBe("move");
    });
    it("digs a Major in beside its Truck or depot, early, and not elsewhere", () => {
      const truck = game([P(1, "us", "7", 8, 5), P(2, "us", "F", 9, 5), FAR]);
      expect(botMove(truck, seeded(1))).toMatchObject({ kind: "dig_in", id: 1 });
      const depot = game([P(1, "us", "7", 8, 3), P(2, "us", "F", 9, 9), FAR]);
      expect(botMove(depot, seeded(1))).toMatchObject({ kind: "dig_in", id: 1 });
      const late = game([P(1, "us", "7", 8, 5), P(2, "us", "F", 9, 9), FAR], { turnNo: 60 });
      expect(botMove(late, seeded(1))?.kind).toBe("move");
      const away = game([P(1, "us", "7", 6, 5), P(2, "us", "F", 9, 9), FAR]);
      expect(botMove(away, seeded(1))?.kind).toBe("move");
    });
    it("switches the 10 only to attack a 10 that is already shown", () => {
      const shown = game([P(1, "us", "10", 6, 0), P(2, "it", "10", 5, 0, { known: true }), P(3, "us", "F", 9, 9), FAR]);
      expect(botMove(shown, seeded(1))).toMatchObject({ kind: "move", id: 1, to: { r: 5, c: 0 }, switch: true });
      const hidden = game([P(1, "us", "10", 6, 0), P(2, "it", "10", 5, 0), P(3, "us", "F", 9, 9), FAR]);
      for (let seed = 1; seed < 20; seed++) expect(botMove(hidden, seeded(seed))).toMatchObject({ switch: false });
    });
    it("does not attack a shown Landmine with an Engineer now that it can't defuse", () => {
      const g = game([P(1, "us", "3", 6, 0), P(2, "it", "B", 5, 0, { known: true }), P(3, "us", "F", 9, 9), FAR]);
      for (let seed = 1; seed < 20; seed++) {
        const m = botMove(g, seeded(seed));
        expect(m).not.toMatchObject({ kind: "move", to: { r: 5, c: 0 } });
      }
    });
  });

  describe("fortress policy", () => {
    it("walks both Majors to its Truck and digs them in around it", () => {
      const rng = seeded(11);
      let g = game([P(1, "us", "7", 7, 2), P(2, "us", "7", 7, 7), P(3, "us", "F", 9, 5), P(4, "us", "5", 7, 5), P(5, "it", "2", 0, 9), P(6, "it", "3", 0, 0)], { stormDone: true });
      for (let i = 0; i < 80 && g.digs.us < 2 && !g.winner; i++) {
        const m = botMove(g, rng, g.turn === "us" ? "fortress" : "standard");
        if (!m) break;
        if (m.twoStep) {
          const s = startTwoStep(g, T0 + i * 1000);
          if (s.ok) g = s.game;
        }
        const r = applyBot({ ...g, deadline: T0 + i * 1000 + TURN_MS }, m, T0 + i * 1000);
        if (!r.ok) throw new Error(r.reason);
        g = r.game;
      }
      expect(g.digs.us).toBe(2);
      const truck = g.pieces.find((p) => p.id === 3)!;
      for (const id of [1, 2]) {
        const p = g.pieces.find((x) => x.id === id)!;
        expect(g.changed[id]).toBe("dug");
        expect(Math.max(Math.abs(p.r - truck.r), Math.abs(p.c - truck.c))).toBe(1);
      }
    });
    it("plays whole Matches against the standard bot and ends them", () => {
      let dug = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const g = playOut(seed, ["fortress", "standard"]);
        expect(g.winner).not.toBeNull();
        dug += g.digs.us;
      }
      expect(dug).toBeGreaterThan(0);
    }, 60_000);
  });
});

