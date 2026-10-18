import { describe, expect, it } from "vitest";
import { DEPOTS, ROSTER, fight, isWadi, move, newGame, placeArmy, seeded, startTwoStep, storm, targets, timeout, type Game, type Piece, type Rank } from "./rules";

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
    stormAt: 999,
    stormDone: true,
    winner: null,
    reason: null,
    ...over,
  };
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
    const g = newGame(seeded(3));
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
    expect(fight("10", "1")).toBe("win");
    expect(fight("3", "B")).toBe("defuse");
    expect(fight("10", "B")).toBe("mine");
    expect(fight("2", "F")).toBe("truck");
  });
  it("a lost attack flashes only the attacker; the winning defender stays hidden", () => {
    const g = game([P(1, "us", "4", 6, 0), P(2, "it", "7", 5, 0)]);
    const { game: g2, events } = move(g, 1, 5, 0);
    const a = events.find((e) => e.kind === "attack");
    expect(a).toMatchObject({ outcome: "lose", flash: [1] });
    expect(g2.pieces.map((p) => p.id)).toEqual([2]);
  });
  it("a win flashes the beaten piece and moves in", () => {
    const g = game([P(1, "us", "8", 6, 0), P(2, "it", "7", 5, 0), P(3, "it", "5", 0, 9)]);
    const { game: g2, events } = move(g, 1, 5, 0);
    expect(events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "win", flash: [2] });
    expect(g2.pieces.find((p) => p.id === 1)).toMatchObject({ r: 5, c: 0 });
  });
  it("a landmine that goes off survives and is revealed for good", () => {
    const g = game([P(1, "us", "9", 6, 0), P(2, "it", "B", 5, 0), P(4, "us", "5", 9, 9), P(3, "it", "5", 0, 9)]);
    const { game: g2, events } = move(g, 1, 5, 0);
    expect(events.find((e) => e.kind === "attack")).toMatchObject({ outcome: "mine", flash: [2] });
    expect(g2.pieces.map((p) => p.id).sort()).toEqual([2, 3, 4]);
    expect(g2.pieces.find((p) => p.id === 2)!.known).toBe(true);
  });
  it("capturing the Truck ends the Match", () => {
    const g = game([P(1, "us", "2", 9, 0), P(2, "it", "F", 3, 0)]);
    const { game: g2 } = move(g, 1, 3, 0);
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
      return move(x, 2, t.r, t.c).game;
    };
    g = bot(move(g, 1, 8, 0).game);
    g = bot(move(g, 1, 9, 0).game);
    g = bot(move(g, 1, 8, 0).game);
    const me = g.pieces.find((p) => p.id === 1)!;
    expect(targets(g, me).some((s) => s.r === 9 && s.c === 0)).toBe(false);
  });
  it("the Truck: never two own turns in a row, three moves, then Spotted and stuck", () => {
    let g = game([P(1, "us", "F", 9, 5), P(3, "us", "5", 9, 0), P(2, "it", "4", 0, 9), P(4, "it", "4", 0, 0)]);
    const pass = (x: Game) => {
      const it = x.pieces.find((p) => p.army === "it" && targets(x, p).length)!;
      const t = targets(x, it)[0];
      return move(x, it.id, t.r, t.c).game;
    };
    g = pass(move(g, 1, 8, 5).game);
    expect(targets(g, g.pieces.find((p) => p.id === 1)!)).toEqual([]); // transmission
    g = pass(move(g, 3, 8, 0).game);
    g = pass(move(g, 1, 7, 5).game);
    g = pass(move(g, 3, 9, 0).game);
    const r = move(g, 1, 6, 5);
    expect(r.events.some((e) => e.kind === "spotted")).toBe(true);
    const truck = r.game.pieces.find((p) => p.id === 1)!;
    expect(truck.known).toBe(true);
    expect(targets({ ...r.game, turn: "us", turnNo: r.game.turnNo + 1 }, truck)).toEqual([]);
  });
});

describe("depots", () => {
  it("a one-square step onto the enemy depot banks a Two-Step Turn, once", () => {
    const g = game([P(1, "us", "5", 2, 5), P(2, "it", "4", 9, 9)]);
    const r = move(g, 1, 1, 5);
    expect(r.events.some((e) => e.kind === "raid")).toBe(true);
    expect(r.game.twoStep.us).toBe(1);
    expect(r.game.depots.find((d) => d.raider === "us")!.claimed).toBe(true);
  });
  it("a Recon run onto the depot does not claim it", () => {
    const g = game([P(1, "us", "2", 3, 5), P(2, "it", "4", 9, 9)]);
    const r = move(g, 1, 1, 5);
    expect(r.game.twoStep.us).toBe(0);
  });
  it("a Two-Step Turn gives two single steps", () => {
    const g = startTwoStep(game([P(1, "us", "2", 9, 0), P(2, "it", "4", 0, 9)], { twoStep: { us: 1, it: 0 } }));
    expect(g.stepsLeft).toBe(2);
    expect(targets(g, g.pieces[0]).every((s) => Math.abs(s.r - 9) + Math.abs(s.c) === 1)).toBe(true);
    const a = move(g, 1, 8, 0).game;
    expect(a.turn).toBe("us");
    const b = move(a, 1, 7, 0).game;
    expect(b.turn).toBe("it");
  });
});

describe("clock and storm", () => {
  it("three timeouts in a row lose the Match", () => {
    let g = game([P(1, "us", "5", 9, 0), P(2, "it", "4", 0, 9)]);
    for (let i = 0; i < 2; i++) {
      g = timeout(g).game; // US
      g = move(g, 2, g.pieces[1].r + 1, 9).game; // Italy moves
    }
    expect(timeout(g).game).toMatchObject({ winner: "it", reason: "timeouts" });
  });
  it("the Dust Storm shifts one line by a square, blocked pieces stay", () => {
    const g = game([P(1, "us", "5", 7, 0), P(2, "us", "4", 7, 1), P(3, "us", "6", 7, 9), P(4, "it", "4", 0, 5)]);
    const { game: g2, event } = storm(g, seeded(11));
    expect(event?.kind).toBe("storm");
    if (event?.kind !== "storm") return;
    for (const s of event.shifts) expect(Math.abs(s.to.r - s.from.r) + Math.abs(s.to.c - s.from.c)).toBe(1);
    expect(new Set(g2.pieces.map((p) => `${p.r},${p.c}`)).size).toBe(g2.pieces.length);
  });
});
