/**
 * Vanguard rules (prototype): blitz Stratego on a 10×10 board, US Army against the Royal Italian Army.
 * Pure functions over a plain `Game` value; every change comes back with the events the screen animates.
 * Source: Vanguard_Game_Manual.pdf + "Vanguard Game Design v2" (depots in the enemy base, no shuttling,
 * 3 timeouts lose, safety cap).
 * Deterministic given its inputs: setup randomness, the storm seed and every action time are passed in. Rows run top (0, board row 10, Italy's back row) to bottom (9, board row 1).
 */

export type Army = "us" | "it";
export type Rank = "10" | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2" | "1" | "B" | "F";

export const SIZE = 10;
export const TURN_MS = 5000;
/** How long a turn lasts and how much extra time the chain gives for network delay. */
export interface ClockConfig { turnMs: number; graceMs: number; openingGraceMs: number }
/** Bump with the program's RULES_VERSION when a rule changes. */
export const RULES_VERSION = 3;
/** Extra time on the chain's opening turn only: the deal starts the first mover's clock before they have loaded their Army (the program has the same number, OPENING_GRACE_SECS). */
export const OPENING_GRACE_MS = 10_000;
/** Practice has no network: the turn ends exactly when the 5 seconds do. */
export const PRACTICE_CLOCK: ClockConfig = { turnMs: TURN_MS, graceMs: 0, openingGraceMs: 0 };
/** On the chain a move is accepted until 5 s + 1 s of grace after the turn started; the program has the same two numbers (GRACE_SECS). */
export const CHAIN_CLOCK: ClockConfig = { turnMs: TURN_MS, graceMs: 1000, openingGraceMs: OPENING_GRACE_MS };
export const TRUCK_FUEL = 3;
export const MOVE_CAP = 200;
/** The time cap: after this long from the start a Match ends on the tiebreak (15 minutes). */
export const CAP_MS = 15 * 60 * 1000;
/** The turns on which the Dust Storm may blow (placeholder window until the bot simulation sets it). */
export const STORM_WINDOW = { from: 10, to: 18 } as const;
export const TIMEOUTS_TO_LOSE = 3;

export const ROSTER: [Rank, number][] = [
  ["10", 1], ["9", 1], ["8", 1], ["7", 2], ["6", 2], ["5", 2], ["4", 2], ["3", 2], ["2", 3], ["1", 1], ["B", 2], ["F", 1],
];

export const NAMES: Record<Rank, string> = {
  "10": "General of the Army", "9": "General", "8": "Colonel", "7": "Major", "6": "Captain", "5": "Lieutenant",
  "4": "Sergeant", "3": "Engineer", "2": "Recon", "1": "Spy", B: "Landmine", F: "Supply Truck",
};

export const ARMY_NAME: Record<Army, string> = { us: "US Army", it: "Royal Italian Army" };

export const enemy = (a: Army): Army => (a === "us" ? "it" : "us");

/** Start zones: Italy rows 0-2 (board rows 10-8), the US rows 7-9 (board rows 3-1). */
export const ZONE: Record<Army, number[]> = { it: [0, 1, 2], us: [7, 8, 9] };
/** The row facing no-man's-land: no Landmine or Truck spawns there. */
const FRONT: Record<Army, number> = { it: 2, us: 7 };

/** The two wadis (impassable), board rows 5-6, columns 3-4 and 7-8. */
export const isWadi = (r: number, c: number) => (r === 4 || r === 5) && (c === 2 || c === 3 || c === 6 || c === 7);
export const onBoard = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

export interface Square { r: number; c: number }

export interface Piece extends Square {
  id: number;
  army: Army;
  rank: Rank;
  /** Shown face up to the enemy for good (only the Truck, once Spotted). */
  known: boolean;
  /** Supply Truck moves used (fuel). */
  fuel: number;
  /** Squares this piece stood on, newest last, for the no-shuttling rule. */
  trail: string[];
}

export interface Depot extends Square {
  /** The army that may raid it (the depot sits in the other army's base). */
  raider: Army;
  claimed: boolean;
}

export interface Game {
  pieces: Piece[];
  depots: Depot[];
  turn: Army;
  /** Turns played so far (both armies). */
  turnNo: number;
  /** Moves made, for the safety cap. */
  moves: number;
  /** Two-Step Turns banked per army. */
  twoStep: Record<Army, number>;
  /** Steps still to make this turn: 1 normally, 2 in a Two-Step Turn (each a one-square step). */
  stepsLeft: number;
  twoStepActive: boolean;
  /** Timed-out turns in a row per army. */
  timeouts: Record<Army, number>;
  /** The turn number each army last moved its Truck on. */
  truckTurn: Record<Army, number>;
  /** Pieces moved in this turn (a Two-Step Turn may move the Truck once). */
  movedThisTurn: number[];
  /** Rollup time the Match started at (ms), for the time cap. */
  startedAt: number;
  clock: ClockConfig;
  /** The current turn's deadline (ms): a move at or before it is accepted, a timeout only after it. */
  deadline: number;
  /** Turn on which the Dust Storm blows (once per Match). */
  stormAt: number;
  /** Seeds the storm's line and direction, which are drawn when it fires. */
  stormSeed: number;
  stormDone: boolean;
  /** Sequence number the next event gets. */
  eventSeq: number;
  winner: Army | "draw" | null;
  reason: EndReason | null;
}

/** Why an action was refused. Closed set: the codes never name a rule that depends on a hidden rank. */
export const REFUSALS = ["match_over", "cap_passed", "turn_expired", "turn_not_expired", "not_your_turn", "no_such_piece", "illegal_move", "no_two_step"] as const;
export type Refusal = (typeof REFUSALS)[number];

export type EndReason = "truck" | "stuck" | "timeouts" | "cap";

export type Outcome = "win" | "lose" | "tie" | "mine" | "defuse" | "truck";

export type GameEventBody =
  | { kind: "move"; id: number; from: Square; to: Square }
  | {
      kind: "attack";
      att: number;
      def: number;
      from: Square;
      to: Square;
      outcome: Outcome;
      /** Pieces whose face is flashed to the other side: the beaten piece, both in a tie, a Landmine that went off. Other winners stay hidden. */
      flash: number[];
    }
  | { kind: "spotted"; id: number }
  | { kind: "raid"; army: Army; at: Square }
  | { kind: "storm"; axis: "row" | "col"; index: number; dir: 1 | -1; shifts: { id: number; from: Square; to: Square }[] }
  | { kind: "turn"; turn: Army; timedOut: boolean }
  | { kind: "end"; winner: Army | "draw"; reason: EndReason };

/** What happened, numbered in the order it happened (the numbering never restarts within a Match). */
export type GameEvent = GameEventBody & { seq: number };

export type Rng = () => number;

const key = (s: Square) => `${s.r},${s.c}`;

function shuffle<T>(a: T[], rng: Rng): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** US raids the depot at board row 9 column 6; Italy raids board row 2 column 5. */
export const DEPOTS: Depot[] = [
  { r: 1, c: 5, raider: "us", claimed: false },
  { r: 8, c: 4, raider: "it", claimed: false },
];

/** The depot inside `army`'s base (the one its enemy raids). */
const ownDepot = (army: Army) => DEPOTS.find((d) => d.raider === enemy(army))!;

/** The 60 start-zone squares in a fixed order (Italy rows 0-2, then the US rows 7-9, each row left to right). A piece's number is the index of its start square here. */
export const START_SQUARES: Square[] = [...ZONE.it, ...ZONE.us].flatMap((r) => Array.from({ length: SIZE }, (_, c) => ({ r, c })));
const START_INDEX = new Map(START_SQUARES.map((s, i) => [key(s), i]));
export const startIndex = (r: number, c: number): number => START_INDEX.get(key({ r, c })) ?? -1;

export interface LayoutPiece { army: Army; rank: Rank; r: number; c: number }

const byId = (a: Piece, b: Piece) => a.id - b.id;

/**
 * Drop one army at random (no setup phase). Landmines and the Truck never spawn on the front row;
 * the depot square stays empty and no Landmine spawns next to it.
 */
export function placeArmy(army: Army, rng: Rng): LayoutPiece[] {
  const dep = ownDepot(army);
  const squares = ZONE[army].flatMap((r) => Array.from({ length: SIZE }, (_, c) => ({ r, c }))).filter((s) => !(s.r === dep.r && s.c === dep.c));
  const nextToDepot = (s: Square) => Math.abs(s.r - dep.r) + Math.abs(s.c - dep.c) === 1;
  const ranks = ROSTER.flatMap(([rank, n]) => Array<Rank>(n).fill(rank));
  const taken = new Set<string>();
  const out: LayoutPiece[] = [];
  const put = (rank: Rank, ok: (s: Square) => boolean) => {
    const s = shuffle(squares, rng).find((q) => !taken.has(key(q)) && ok(q))!;
    taken.add(key(s));
    out.push({ army, rank, r: s.r, c: s.c });
  };
  // the restricted pieces first, so they always find a legal square
  for (const rank of ranks.filter((r) => r === "B")) put(rank, (s) => s.r !== FRONT[army] && !nextToDepot(s));
  for (const rank of ranks.filter((r) => r === "F")) put(rank, (s) => s.r !== FRONT[army]);
  for (const rank of ranks.filter((r) => r !== "B" && r !== "F")) put(rank, () => true);
  return out;
}

export interface StartOptions {
  startedAt: number;
  stormAt: number;
  stormSeed: number;
  first: Army;
  /** Defaults to the Practice clock. */
  clock?: ClockConfig;
}

const turnEnd = (g: { clock: ClockConfig }, at: number) => at + g.clock.turnMs + g.clock.graceMs;

/** A Match from an explicit layout. Piece numbers come from the start squares, never from the order given. */
export function startGame(layout: LayoutPiece[], o: StartOptions): Game {
  const pieces: Piece[] = layout.map((l) => ({ id: startIndex(l.r, l.c), army: l.army, rank: l.rank, r: l.r, c: l.c, known: false, fuel: 0, trail: [key(l)] })).sort(byId);
  const clock = o.clock ?? PRACTICE_CLOCK;
  return {
    pieces,
    depots: DEPOTS.map((d) => ({ ...d })),
    turn: o.first,
    turnNo: 0,
    moves: 0,
    twoStep: { us: 0, it: 0 },
    stepsLeft: 1,
    twoStepActive: false,
    timeouts: { us: 0, it: 0 },
    truckTurn: { us: -9, it: -9 },
    movedThisTurn: [],
    startedAt: o.startedAt,
    clock,
    deadline: turnEnd({ clock }, o.startedAt) + clock.openingGraceMs,
    stormAt: o.stormAt,
    stormSeed: o.stormSeed,
    stormDone: false,
    eventSeq: 0,
    winner: null,
    reason: null,
  };
}

/** A random Match: both armies dropped at random, the storm turn and seed drawn up front. */
export function newGame(rng: Rng = Math.random, startedAt = Date.now(), first: Army = "us", clock: ClockConfig = PRACTICE_CLOCK): Game {
  const layout = [...placeArmy("it", rng), ...placeArmy("us", rng)];
  const stormAt = STORM_WINDOW.from + Math.floor(rng() * (STORM_WINDOW.to - STORM_WINDOW.from + 1));
  return startGame(layout, { startedAt, stormAt, stormSeed: Math.floor(rng() * 0x100000000), first, clock });
}

export const pieceAt = (g: Game, r: number, c: number) => g.pieces.find((p) => p.r === r && p.c === c);

const value = (r: Rank) => (r === "B" || r === "F" ? 0 : Number(r));

/** Who wins when `a` attacks `d`. */
export function fight(a: Rank, d: Rank): Outcome {
  if (d === "F") return "truck";
  if (d === "B") return a === "3" ? "defuse" : "mine";
  if (a === d) return "tie";
  if (a === "1" && d === "10") return "win";
  return value(a) > value(d) ? "win" : "lose";
}

/** Can this piece move at all this turn (Landmines never; the Truck has fuel and transmission limits)? */
export function canMove(g: Game, p: Piece): boolean {
  if (p.rank === "B") return false;
  if (p.rank === "F") {
    if (p.fuel >= TRUCK_FUEL) return false;
    if (g.truckTurn[p.army] === g.turnNo - 2) return false; // never two of its own turns in a row
    if (g.movedThisTurn.includes(p.id)) return false; // at most one Truck step in a Two-Step Turn
  }
  return true;
}

/** Squares a piece may move to (or attack) now. */
export function targets(g: Game, p: Piece): (Square & { attack: boolean })[] {
  if (g.winner || p.army !== g.turn || !canMove(g, p)) return [];
  const reach = p.rank === "2" && !g.twoStepActive ? SIZE - 1 : 1;
  const out: (Square & { attack: boolean })[] = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    for (let k = 1; k <= reach; k++) {
      const r = p.r + dr * k;
      const c = p.c + dc * k;
      if (!onBoard(r, c) || isWadi(r, c)) break;
      const o = pieceAt(g, r, c);
      if (o?.army === p.army) break;
      if (!shuttling(p, { r, c })) out.push({ r, c, attack: !!o });
      if (o) break;
    }
  }
  return out;
}

/** No piece may go back and forth between the same two squares more than 3 times in a row. */
function shuttling(p: Piece, to: Square): boolean {
  const t = p.trail;
  if (t.length < 4) return false;
  const [a, b, c, d] = t.slice(-4);
  return a === c && b === d && key(to) === c;
}

export function hasMoves(g: Game, army: Army): boolean {
  const probe = { ...g, turn: army, movedThisTurn: [], twoStepActive: false };
  return g.pieces.some((p) => p.army === army && targets(probe, p).length > 0);
}

export type Result = { ok: true; game: Game; events: GameEvent[] } | { ok: false; reason: Refusal };

const capPassed = (g: Game, at: number) => at > g.startedAt + CAP_MS;

/** Hand the events their numbers and return them with the game. */
function done(g: Game, bodies: GameEventBody[]): Result {
  const events = bodies.map((e, i) => ({ ...e, seq: g.eventSeq + i }) as GameEvent);
  return { ok: true, game: { ...g, eventSeq: g.eventSeq + bodies.length }, events };
}

/** End the Match: every remaining piece turns face up. */
function finish(g: Game, winner: Army | "draw", reason: EndReason): Game {
  return { ...g, pieces: g.pieces.map((p) => ({ ...p, known: true })), winner, reason };
}

/** Why `at` cannot be used for an action on this game, if it cannot. */
function clockRefusal(g: Game, at: number): Refusal | null {
  if (g.winner) return "match_over";
  if (capPassed(g, at)) return "cap_passed";
  if (at > g.deadline) return "turn_expired";
  return null;
}

/** Spend a banked Two-Step Turn on this turn (before the first step). It does not move the deadline. */
export function startTwoStep(g: Game, at: number): Result {
  const late = clockRefusal(g, at);
  if (late) return { ok: false, reason: late };
  if (g.twoStep[g.turn] < 1 || g.twoStepActive || g.movedThisTurn.length) return { ok: false, reason: "no_two_step" };
  return done({ ...g, twoStep: { ...g.twoStep, [g.turn]: g.twoStep[g.turn] - 1 }, twoStepActive: true, stepsLeft: 2 }, []);
}

/** `at` is when the move was made (the clock checks use it); `resolvedAt` is when the chain applied it, which is later (default: `at`). */
export interface MoveAction { id: number; to: Square; at: number; resolvedAt?: number }

/** Move (or attack with) piece `id` to `to` at time `at`. Returns the new game and what happened, in order. */
export function move(g0: Game, a: MoveAction): Result {
  const { id, at } = a;
  const { r, c } = a.to;
  const late = clockRefusal(g0, at);
  if (late) return { ok: false, reason: late };
  const p0 = g0.pieces.find((p) => p.id === id);
  if (!p0) return { ok: false, reason: "no_such_piece" };
  if (p0.army !== g0.turn) return { ok: false, reason: "not_your_turn" };
  if (!targets(g0, p0).some((t) => t.r === r && t.c === c)) return { ok: false, reason: "illegal_move" };
  const army = p0.army;
  const events: GameEventBody[] = [];
  let pieces = g0.pieces.map((p) => ({ ...p }));
  const me = pieces.find((p) => p.id === id)!;
  const from = { r: me.r, c: me.c };
  const step = Math.abs(from.r - r) + Math.abs(from.c - c) === 1;
  const def = pieces.find((p) => p.r === r && p.c === c);
  let g: Game = { ...g0, depots: g0.depots.map((d) => ({ ...d })), moves: g0.moves + 1, timeouts: { ...g0.timeouts, [army]: 0 } };

  const land = () => {
    me.r = r;
    me.c = c;
    me.trail = [...me.trail.slice(-5), key({ r, c })];
  };
  if (me.rank === "F") {
    me.fuel += 1;
    g.truckTurn = { ...g.truckTurn, [army]: g.turnNo };
    if (me.fuel >= TRUCK_FUEL) me.known = true;
  }

  if (!def) {
    land();
    events.push({ kind: "move", id, from, to: { r, c } });
  } else {
    const outcome = fight(me.rank, def.rank);
    // a blown Landmine is revealed for good (founder 2026-10-19); otherwise only the beaten piece is flashed
    const flash = outcome === "tie" ? [me.id, def.id] : outcome === "lose" ? [me.id] : [def.id];
    if (outcome === "mine") def.known = true;
    events.push({ kind: "attack", att: me.id, def: def.id, from, to: { r, c }, outcome, flash });
    if (outcome === "win" || outcome === "defuse" || outcome === "truck") {
      pieces = pieces.filter((p) => p.id !== def.id);
      land();
    } else if (outcome === "tie") {
      pieces = pieces.filter((p) => p.id !== def.id && p.id !== me.id);
    } else {
      pieces = pieces.filter((p) => p.id !== me.id);
    }
    if (outcome === "truck") {
      events.push({ kind: "end", winner: army, reason: "truck" });
      return done(finish({ ...g, pieces }, army, "truck"), events);
    }
  }
  if (me.rank === "F" && me.fuel >= TRUCK_FUEL && pieces.includes(me)) events.push({ kind: "spotted", id });

  // a one-square step onto the enemy's depot claims it (once per Match)
  const dep = g.depots.find((d) => d.r === r && d.c === c && d.raider === army && !d.claimed);
  if (dep && step && pieces.includes(me) && me.r === r && me.c === c) {
    dep.claimed = true;
    g.twoStep = { ...g.twoStep, [army]: g.twoStep[army] + 1 };
    events.push({ kind: "raid", army, at: { r, c } });
  }

  g = { ...g, pieces, movedThisTurn: [...g.movedThisTurn, id], stepsLeft: g.stepsLeft - 1, deadline: turnEnd(g, a.resolvedAt ?? at) };
  // a Two-Step Turn continues while there is a second step to make
  if (g.stepsLeft > 0 && g.pieces.some((p) => p.army === army && targets(g, p).length > 0)) return done(g, events);
  return endTurn(g, events, false);
}

/**
 * Nobody moved in time (the turn passes; three in a row lose the Match), or the time cap has passed
 * (the Match ends on the tiebreak whatever the turn clock says). On the chain the claim is judged at `at` and applied at
 * `resolvedAt`; the next deadline counts from the latter.
 */
export function timeout(g: Game, at: number, resolvedAt: number = at): Result {
  if (g.winner) return { ok: false, reason: "match_over" };
  if (capPassed(g, at)) {
    const winner = capWinner(g);
    return done(finish(g, winner, "cap"), [{ kind: "end", winner, reason: "cap" }]);
  }
  if (at <= g.deadline) return { ok: false, reason: "turn_not_expired" };
  const army = g.turn;
  const n = g.timeouts[army] + 1;
  const g1 = { ...g, timeouts: { ...g.timeouts, [army]: n } };
  if (n >= TIMEOUTS_TO_LOSE) {
    const winner = enemy(army);
    return done(finish(g1, winner, "timeouts"), [{ kind: "end", winner, reason: "timeouts" }]);
  }
  return endTurn({ ...g1, deadline: turnEnd(g1, resolvedAt) }, [], true);
}

/** The turn passes; `g0.deadline` is already the next side's deadline. */
function endTurn(g0: Game, events: GameEventBody[], timedOut: boolean): Result {
  let g: Game = { ...g0, turn: enemy(g0.turn), turnNo: g0.turnNo + 1, stepsLeft: 1, twoStepActive: false, movedThisTurn: [] };
  if (!g.stormDone && g.turnNo >= g.stormAt) {
    const s = storm(g);
    g = s.game;
    if (s.event) events.push(s.event);
  }
  events.push({ kind: "turn", turn: g.turn, timedOut });
  if (g.moves >= MOVE_CAP) {
    const winner = capWinner(g);
    events.push({ kind: "end", winner, reason: "cap" });
    return done(finish(g, winner, "cap"), events);
  }
  if (!hasMoves(g, g.turn)) {
    const winner = enemy(g.turn);
    events.push({ kind: "end", winner, reason: "stuck" });
    return done(finish(g, winner, "stuck"), events);
  }
  return done(g, events);
}

/** At the safety cap: higher total of surviving ranks wins (Landmines and the Truck count 0), then more pieces, else a draw. */
export function capWinner(g: Game): Army | "draw" {
  const sum = (a: Army) => g.pieces.filter((p) => p.army === a).reduce((s, p) => s + value(p.rank), 0);
  const n = (a: Army) => g.pieces.filter((p) => p.army === a).length;
  if (sum("us") !== sum("it")) return sum("us") > sum("it") ? "us" : "it";
  if (n("us") !== n("it")) return n("us") > n("it") ? "us" : "it";
  return "draw";
}

/**
 * The Dust Storm (once per Match): a random row or column with at least two pieces drifts one square.
 * The line and direction come from the game's storm seed at the moment the storm fires.
 * Pieces nearest the edge they drift toward move first; one that would leave the board, enter a wadi or
 * hit another piece stays put. A storm never claims a depot.
 */
export function storm(g: Game): { game: Game; event: GameEventBody | null } {
  const rng = seeded(g.stormSeed);
  const lines: { axis: "row" | "col"; index: number }[] = [];
  for (let i = 0; i < SIZE; i++) {
    if (g.pieces.filter((p) => p.r === i).length >= 2) lines.push({ axis: "row", index: i });
    if (g.pieces.filter((p) => p.c === i).length >= 2) lines.push({ axis: "col", index: i });
  }
  if (!lines.length) return { game: { ...g, stormDone: true }, event: null };
  const { axis, index } = lines[Math.floor(rng() * lines.length)];
  const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const pieces = g.pieces.map((p) => ({ ...p }));
  const inLine = pieces.filter((p) => (axis === "row" ? p.r === index : p.c === index)).sort((a, b) => (axis === "row" ? (b.c - a.c) * dir : (b.r - a.r) * dir));
  const shifts: { id: number; from: Square; to: Square }[] = [];
  for (const p of inLine) {
    const to = axis === "row" ? { r: p.r, c: p.c + dir } : { r: p.r + dir, c: p.c };
    if (!onBoard(to.r, to.c) || isWadi(to.r, to.c) || pieces.some((o) => o.r === to.r && o.c === to.c)) continue;
    shifts.push({ id: p.id, from: { r: p.r, c: p.c }, to });
    p.r = to.r;
    p.c = to.c;
    p.trail = [key(to)];
  }
  return { game: { ...g, pieces, stormDone: true }, event: { kind: "storm", axis, index, dir, shifts } };
}

/** Seeded random numbers for tests and stories (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
