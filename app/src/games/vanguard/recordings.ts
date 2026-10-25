/**
 * Shared recordings: Matches played with the app's rules engine under the chain clock, written to
 * programs/vanguard/tests/fixtures/recordings.json. The program's Rust engine replays every action and must
 * reach the same public board and the same events, or the same refusal. Times are whole seconds, as on the chain.
 *
 * Regenerate with `WRITE_RECORDINGS=1 pnpm --filter @tesoro/app exec vitest run src/games/vanguard/recordings.test.ts`.
 */
import { botMove, type BotAction, type Policy } from "./practice/bot";
import {
  CAP_MS, CHAIN_CLOCK, DEPOTS, MOVE_CAP, ROSTER, RULES_VERSION, SIZE, STORM_WINDOW, TIMEOUTS_TO_LOSE, TRUCK_FUEL, act, hasAction, hasStep, isWadi, move, newGame, pass, rankOf, seeded, startGame, startIndex, startTwoStep, targets, timeout,
  type Army, type Game, type GameEvent, type Piece, type Rank, type Refusal, type Result, type Square,
} from "./rules";

export interface PublicState {
  turn: Army;
  turnNo: number;
  moves: number;
  twoStep: [number, number];
  stepsLeft: number;
  twoStepActive: boolean;
  timeouts: [number, number];
  /** Seconds. */
  deadline: number;
  stormDone: boolean;
  eventSeq: number;
  winner: Army | "draw" | null;
  reason: string | null;
  /** Whether the depot each army raids (us first) has been claimed. */
  depots: [boolean, boolean];
  /** Every piece on the board as `<id><u|i><row><col>=<rank or ?>`, in id order. A rank shows only once it is public. */
  board: string;
}

/**
 * `switch` and `digIn` are the sealed bytes of the chain instructions: a switch is "Become a Spy first", `digIn` is the piece
 * number a pass digs in (any number at all, an invalid one is a plain pass).
 */
export type RecAction =
  | { kind: "move"; id: number; to: [number, number]; at: number; switch?: true; expect: Expect }
  | { kind: "blast" | "rescue"; id: number; at: number; switch?: true; expect: Expect }
  | { kind: "pass"; at: number; digIn?: number; switch?: true; expect: Expect }
  | { kind: "two_step" | "timeout"; at: number; expect: Expect };
/**
 * `secret` is what the public state leaves out: the pieces whose rank changed (dead ones too) and the ones still on the board
 * with their private code, so the Rust engine's private rank codes are held to the TypeScript twin after every action.
 */
export interface Secret { changed: number[]; codes: string[] }
export type Expect = { ok: true; events: GameEvent[]; state: PublicState; secret: Secret } | { ok: false; reason: Refusal };

export interface Recording {
  name: string;
  tags: string[];
  /** The rules version (default: the current one). */
  version: number;
  /** `<army>:<rank>:<row>:<col>:<piece number>:<known 0|1>:<fuel>` */
  layout: string[];
  first: Army;
  startedAt: number;
  stormAt: number;
  stormSeed: number;
  actions: RecAction[];
}

export const RECORDINGS_PATH = "programs/vanguard/tests/fixtures/recordings.json";
const START_SEC = 1_000_000;

export function publicState(g: Game): PublicState {
  const claimed = (raider: Army) => g.depots.find((d) => d.raider === raider)!.claimed;
  return {
    turn: g.turn,
    turnNo: g.turnNo,
    moves: g.moves,
    twoStep: [g.twoStep.us, g.twoStep.it],
    stepsLeft: g.stepsLeft,
    twoStepActive: g.twoStepActive,
    timeouts: [g.timeouts.us, g.timeouts.it],
    deadline: g.deadline / 1000,
    stormDone: g.stormDone,
    eventSeq: g.eventSeq,
    winner: g.winner,
    reason: g.reason,
    depots: [claimed("us"), claimed("it")],
    board: g.pieces.map((p) => `${p.id}${p.army === "us" ? "u" : "i"}${p.r}${p.c}=${p.known ? rankOf(g, p) : "?"}`).join(","),
  };
}

export function secretOf(g: Game): Secret {
  return {
    changed: Object.keys(g.changed).map(Number).sort((a, b) => a - b),
    codes: g.pieces.filter((p) => g.changed[p.id]).map((p) => `${p.id}:${g.changed[p.id]}`),
  };
}

export function constants() {
  return {
    SIZE,
    TURN_SECS: CHAIN_CLOCK.turnMs / 1000,
    GRACE_SECS: CHAIN_CLOCK.graceMs / 1000,
    OPENING_GRACE_SECS: CHAIN_CLOCK.openingGraceMs / 1000,
    RESOLVE_SLACK_SECS: CHAIN_CLOCK.resolveSlackMs / 1000,
    RULES_VERSION,
    CAP_SECS: CAP_MS / 1000,
    MOVE_CAP,
    TIMEOUTS_TO_LOSE,
    TRUCK_FUEL,
    STORM_FROM: STORM_WINDOW.from,
    STORM_TO: STORM_WINDOW.to,
    ROSTER: ROSTER.map(([rank, n]) => `${rank}x${n}`),
    DEPOTS: DEPOTS.map((d) => `${d.raider}:${d.r}:${d.c}`),
    WADIS: Array.from({ length: SIZE * SIZE }, (_, i) => [Math.floor(i / SIZE), i % SIZE]).filter(([r, c]) => isWadi(r, c)).map(([r, c]) => `${r}:${c}`),
  };
}

const layoutString = (p: Piece) => `${p.army}:${p.rank}:${p.r}:${p.c}:${p.id}:${p.known ? 1 : 0}:${p.fuel}`;
const pieceOf = (s: string): Piece => {
  const [army, rank, r, c, id, known, fuel] = s.split(":");
  return { id: Number(id), army: army as Army, rank: rank as Rank, r: Number(r), c: Number(c), known: known === "1", fuel: Number(fuel), trail: [`${r},${c}`] };
};

/** The game a recording starts from. */
export function startOf(rec: Pick<Recording, "layout" | "startedAt" | "stormAt" | "stormSeed" | "first" | "version">): Game {
  const g = startGame([], { startedAt: rec.startedAt * 1000, stormAt: rec.stormAt, stormSeed: rec.stormSeed, first: rec.first, clock: CHAIN_CLOCK, version: rec.version });
  return { ...g, pieces: rec.layout.map(pieceOf).sort((x, y) => x.id - y.id) };
}

/** Run one recorded action on the TS engine. */
export function apply(g: Game, a: RecAction): Result {
  const at = a.at * 1000;
  if (a.kind === "move") return move(g, { id: a.id, to: { r: a.to[0], c: a.to[1] }, at, switch: a.switch });
  if (a.kind === "blast" || a.kind === "rescue") return act(g, { kind: a.kind, id: a.id, at, switch: a.switch });
  if (a.kind === "pass") return pass(g, { at, switch: a.switch, digIn: a.digIn });
  if (a.kind === "two_step") return startTwoStep(g, at);
  return timeout(g, at);
}

export const expectOf = (res: Result): Expect => (res.ok ? { ok: true, events: res.events, state: publicState(res.game), secret: secretOf(res.game) } : { ok: false, reason: res.reason });

type Free = [Army, Rank, number, number, number?, boolean?, number?];

/** Pieces with their numbers: a piece on its own start square gets that square's number, the others take the next free number of their army. */
function place(pieces: Free[]): Piece[] {
  const used = new Set<number>();
  const ids = pieces.map(([army, , r, c, id]) => {
    const home = startIndex(r, c);
    const n = id ?? (home >= 0 && (home >= 30) === (army === "us") ? home : undefined);
    if (n !== undefined) {
      if (used.has(n)) throw new Error(`piece number ${n} used twice`);
      used.add(n);
    }
    return n;
  });
  return pieces.map(([army, rank, r, c, , known, fuel], i) => {
    let id = ids[i];
    if (id === undefined) {
      id = army === "us" ? 30 : 0;
      while (used.has(id)) id++;
      used.add(id);
    }
    return { id, army, rank, r, c, known: known ?? false, fuel: fuel ?? 0, trail: [`${r},${c}`] };
  });
}

class Rec {
  g: Game;
  readonly actions: RecAction[] = [];
  private readonly rec: Omit<Recording, "actions">;
  private dummies = { us: 0, it: 0 };
  constructor(name: string, tags: string[], g: Game) {
    this.g = g;
    this.rec = {
      name,
      tags,
      version: g.version,
      layout: g.pieces.map(layoutString),
      first: g.turn,
      startedAt: g.startedAt / 1000,
      stormAt: g.stormAt,
      stormSeed: g.stormSeed,
    };
  }
  private run(a: RecAction): Result {
    const res = apply(this.g, a);
    this.actions.push({ ...a, expect: expectOf(res) });
    if (res.ok) this.g = res.game;
    return res;
  }
  move(id: number, to: [number, number], at: number, sw = false) {
    return this.run({ kind: "move", id, to, at, ...(sw ? { switch: true as const } : {}), expect: null as never });
  }
  act(kind: "blast" | "rescue", id: number, at: number, sw = false) {
    return this.run({ kind, id, at, ...(sw ? { switch: true as const } : {}), expect: null as never });
  }
  pass(at: number, o: { digIn?: number; sw?: boolean } = {}) {
    return this.run({ kind: "pass", at, ...(o.digIn === undefined ? {} : { digIn: o.digIn }), ...(o.sw ? { switch: true as const } : {}), expect: null as never });
  }
  twoStep(at: number) {
    return this.run({ kind: "two_step", at, expect: null as never });
  }
  timeout(at: number) {
    return this.run({ kind: "timeout", at, expect: null as never });
  }
  /** Seconds of the current deadline. */
  get deadline() {
    return this.g.deadline / 1000;
  }
  /** The number of the piece that stood on (r, c) when the Match began. */
  at(r: number, c: number): number {
    const s = this.rec.layout.find((l) => l.split(":")[2] === String(r) && l.split(":")[3] === String(c));
    if (!s) throw new Error(`no piece starts on ${r},${c}`);
    return Number(s.split(":")[4]);
  }
  piece(id: number): Piece {
    const p = this.g.pieces.find((q) => q.id === id);
    if (!p) throw new Error(`piece ${id} is gone`);
    return p;
  }
  /** The legal targets of a piece now. */
  reach(id: number) {
    return targets(this.g, this.piece(id));
  }
  /** Every square the piece may NOT go to, tried as refused moves (a refusal changes nothing). */
  refuseAll(id: number, t: number, every = 1) {
    const legal = new Set(this.reach(id).map((x) => `${x.r},${x.c}`));
    let n = 0;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) if (!legal.has(`${r},${c}`) && n++ % every === 0) this.move(id, [r, c], t);
  }
  /** Move to the first legal target that satisfies `pred`; throws when there is none (a generator bug). */
  go(id: number, t: number, pred: (x: Square & { attack: boolean }) => boolean, sw = false): Result {
    const x = this.reach(id).find(pred);
    if (!x) throw new Error(`${this.rec.name}: no target for piece ${id} turn=${this.g.turn} at=${JSON.stringify(this.g.pieces.find((q) => q.id === id))} actions=${this.actions.length} last=${JSON.stringify(this.actions.at(-1))}`);
    return this.move(id, [x.r, x.c], t, sw);
  }
  /** One step of the army's dummy Recon around a 2x2 block in a corner, so a turn can pass. */
  dummy(army: Army, t: number, sw = false) {
    const loop: [number, number][] = army === "us" ? [[9, 8], [8, 8], [8, 9], [9, 9]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
    const id = this.rec.layout.map(pieceOf).find((p) => p.army === army && p.r === loop[3][0] && p.c === loop[3][1])?.id;
    if (id === undefined) throw new Error("no dummy");
    return this.move(id, loop[this.dummies[army]++ % 4], t, sw);
  }
  done(): Recording {
    return { ...this.rec, actions: this.actions };
  }
}

const DUMMIES: Free[] = [["us", "2", 9, 9], ["it", "2", 0, 0]];

type L = Free;

function begin(name: string, tags: string[], layout: L[], o: { first?: Army; stormAt?: number; stormSeed?: number; version?: number; dummies?: boolean } = {}): Rec {
  const g = startGame([], { startedAt: START_SEC * 1000, stormAt: o.stormAt ?? 999, stormSeed: o.stormSeed ?? 1, first: o.first ?? "us", clock: CHAIN_CLOCK, version: o.version });
  return new Rec(name, tags, { ...g, pieces: place([...layout, ...(o.dummies ? DUMMIES : [])]).sort((a, b) => a.id - b.id) });
}

const RANKS: Rank[] = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"];
const ALL: Rank[] = [...RANKS, "B", "F"];

/** Every attacker rank against every defender rank: the attacker walks up a column, the Italians shuffle a Recon. */
function pairs(): Recording[] {
  const out: Recording[] = [];
  const dummy: [number, number][] = [[1, 9], [0, 9], [0, 8], [1, 8], [1, 9]];
  const up: [number, number][] = [[6, 0], [5, 0], [4, 0], [3, 0], [2, 0]];
  // the Sergeant never walks straight: it zigzags to a defender on the other colour
  const zigzag: [number, number][] = [[6, 1], [5, 0], [4, 1], [3, 0], [2, 1]];
  for (const att of RANKS) {
    for (const def of ALL) {
      const sergeant = att === "4";
      const target = sergeant ? 1 : 0;
      const rec = begin(`fight ${att} attacks ${def}`, ["fight"], [["us", att, 7, 0], ["it", def, 2, target], ["it", "2", 1, 8]]);
      const a = startIndex(7, 0);
      const d = startIndex(1, 8);
      for (let i = 0; i < 5; i++) {
        rec.move(a, (sergeant ? zigzag : up)[i], 1 + i * 2);
        rec.move(d, dummy[i], 2 + i * 2);
      }
      out.push(rec.done());
    }
  }
  return out;
}

/**
 * Fights with a changed rank (Become a Spy): the US 10 switches on its first move and attacks every rank; every rank attacks
 * the Italian 10, which switches on its dummy's first move. Switched against 10, Spy and switched, both ways.
 */
function switchedFights(): Recording[] {
  const out: Recording[] = [];
  const dummy: [number, number][] = [[1, 9], [0, 9], [0, 8], [1, 8], [1, 9]];
  const up: [number, number][] = [[6, 0], [5, 0], [4, 0], [3, 0], [2, 0]];
  for (const def of ALL) {
    const rec = begin(`fight switched 10 attacks ${def}`, ["fight", "switch"], [["us", "10", 7, 0], ["it", def, 2, 0], ["it", "2", 1, 8]]);
    for (let i = 0; i < 5; i++) {
      rec.move(startIndex(7, 0), up[i], 1 + i * 2, i === 0);
      rec.move(startIndex(1, 8), dummy[i], 2 + i * 2);
    }
    out.push(rec.done());
  }
  for (const att of [...RANKS, "B" as Rank].filter((r) => r !== "B" && r !== "4")) {
    // def 10 switched by the Italian side on its first dummy move; a second Italian 10 is not needed
    const rec = begin(`fight ${att} attacks switched 10`, ["fight", "switch"], [["us", att, 7, 0], ["it", "10", 2, 0], ["it", "2", 1, 8]]);
    for (let i = 0; i < 5; i++) {
      rec.move(startIndex(7, 0), up[i], 1 + i * 2);
      rec.move(startIndex(1, 8), dummy[i], 2 + i * 2, i === 0);
    }
    out.push(rec.done());
  }
  return out;
}

/**
 * Random full-roster Matches played by the practice bot (every power when the policy has them), with late, refused and invalid
 * actions mixed in: strangers' pieces, absent pieces, powers by the wrong rank, Dig ins that name nobody, switches with no 10.
 */
function botMatch(seed: number, policy: Policy | "plain" = "plain", version = RULES_VERSION): Recording {
  const rng = seeded(seed * 7919 + 13);
  const g0 = { ...newGame(seeded(seed), START_SEC * 1000, rng() < 0.5 ? "us" : "it", CHAIN_CLOCK), version };
  const rec = new Rec(`bot match ${seed} (${policy}${version === RULES_VERSION ? "" : `, v${version}`})`, ["bot", ...(version === RULES_VERSION ? [] : ["v5"])], g0);
  let t = START_SEC;
  for (let n = 0; n < 400 && !rec.g.winner; n++) {
    const g = rec.g;
    const roll = rng();
    const mine = g.pieces.find((p) => p.army === g.turn);
    const other = g.pieces.find((p) => p.army !== g.turn);
    if (roll < 0.03) rec.timeout(rec.deadline);
    else if (roll < 0.05 && other) rec.move(other.id, [other.r, other.c], t);
    else if (roll < 0.07) rec.move(99, [0, 0], t);
    else if (roll < 0.09 && g.twoStep[g.turn] === 0) rec.twoStep(t);
    else if (roll < 0.11 && mine) rec.move(mine.id, [mine.r, mine.c], t);
    else if (policy !== "plain" && roll < 0.13 && mine) rec.act(rng() < 0.5 ? "blast" : "rescue", mine.id, t);
    else if (policy !== "plain" && roll < 0.14 && other) rec.act("blast", other.id, t);
    else if (policy !== "plain" && roll < 0.16) rec.pass(t, { digIn: Math.floor(rng() * 70), sw: rng() < 0.3 });
    if (rng() < 0.03) {
      t = rec.deadline + 1;
      const res = rec.timeout(t);
      if (!res.ok) break;
      continue;
    }
    const m: BotAction | null = botMove(rec.g, rng, policy);
    if (!m) break;
    t = Math.min(rec.deadline, t + 1 + Math.floor(rng() * 4));
    const sw = policy !== "plain" && rng() < 0.1;
    if (m.kind === "move") {
      if (m.twoStep && !rec.twoStep(t).ok) break;
      if (rng() < 0.03) rec.move(m.id, [m.to.r, m.to.c], rec.deadline + 1);
      if (!rec.move(m.id, [m.to.r, m.to.c], t, m.switch || sw).ok) break;
    } else if (m.kind === "blast" || m.kind === "rescue") {
      if (!rec.act(m.kind, m.id, t, sw).ok) break;
    } else if (m.kind === "dig_in") {
      if (!rec.pass(t, { digIn: m.id, sw }).ok) break;
    } else if (!rec.pass(t, { sw }).ok) break;
  }
  // after the end every action is refused
  if (rec.g.winner) rec.move(startIndex(7, 0), [6, 0], t + 1);
  return rec.done();
}

const dummyLoop: [number, number][] = [[1, 9], [0, 9], [0, 8], [1, 8]];

/** The Truck is Spotted on its third move and then taken. */
function truckSpotted(): Recording {
  const rec = begin("truck: spotted after three moves, then captured", ["truck", "spotted", "truck-captured"], [
    ["us", "F", 9, 0], ["us", "2", 9, 8], ["it", "2", 0, 0], ["it", "2", 1, 8],
  ]);
  const truck = startIndex(9, 0);
  const other = startIndex(9, 8);
  const d = startIndex(1, 8);
  const otherLoop: [number, number][] = [[9, 9], [8, 9], [8, 8], [9, 8]];
  let t = 1;
  const itDummy = (i: number) => rec.move(d, dummyLoop[i % 4], t++);
  rec.move(truck, [8, 0], t++); // 1st Truck move
  itDummy(0);
  rec.move(truck, [7, 0], t++); // refused: not two of its own turns in a row
  rec.move(other, otherLoop[0], t++);
  itDummy(1);
  rec.move(truck, [7, 0], t++); // 2nd
  itDummy(2);
  rec.move(other, otherLoop[1], t++);
  itDummy(3);
  rec.move(truck, [6, 0], t++); // 3rd: out of fuel, shown face up
  itDummy(4);
  rec.move(truck, [5, 0], t++); // refused: no fuel left
  rec.move(other, otherLoop[2], t++);
  rec.move(startIndex(0, 0), [6, 0], t++); // the Recon runs down the column and takes the Truck
  return rec.done();
}

/** The depot rules and both kinds of Two-Step Turn. */
function depotsAndTwoStep(): Recording {
  const rec = begin("depots: run does not claim, step claims, two kinds of Two-Step Turn", ["depot", "raid", "two-step", "two-step-same-piece", "two-step-two-pieces", "recon-run"], [
    ["us", "2", 7, 5], ["us", "F", 9, 0], ["us", "2", 9, 9], ["us", "9", 9, 2],
    ["it", "2", 2, 4], ["it", "2", 0, 9], ["it", "10", 0, 0],
  ]);
  const R = startIndex(7, 5);
  const T = startIndex(9, 0);
  const S = startIndex(9, 9);
  const Q = startIndex(2, 4);
  const D = startIndex(0, 9);
  let t = 1;
  rec.move(R, [1, 5], t++); // Recon run onto the depot: no claim
  rec.move(D, [0, 8], t++);
  rec.move(R, [1, 4], t++);
  rec.move(Q, [8, 4], t++); // Italian run onto the depot: no claim
  rec.move(R, [1, 5], t++); // a step onto it: claimed
  rec.move(Q, [8, 3], t++);
  rec.twoStep(t++);
  rec.move(T, [8, 0], t++);
  rec.move(T, [7, 0], t++); // refused: the Truck steps once in a Two-Step Turn
  rec.move(S, [8, 9], t++);
  rec.move(Q, [8, 4], t++); // the Italian step onto its depot: claimed
  rec.move(D, [0, 7], t++); // refused: it is the US turn
  rec.move(S, [9, 9], t++);
  rec.twoStep(t++);
  rec.move(Q, [7, 4], t++);
  rec.move(Q, [4, 4], t++); // refused: a Recon only steps once in a Two-Step Turn
  rec.move(Q, [6, 4], t++);
  rec.move(S, [8, 9], t++);
  return rec.done();
}

/** Three timeouts of one side lose; a move in between resets the count. */
function timeouts(): Recording[] {
  const mk = (name: string, tags: string[], seed: number, plan: ("to" | "mv")[]) => {
    const rec = new Rec(name, tags, newGame(seeded(seed), START_SEC * 1000, "us", CHAIN_CLOCK));
    let t = START_SEC;
    for (const step of plan) {
      if (step === "to") {
        t = rec.deadline + 1;
        rec.timeout(t);
      } else {
        const m = botMove(rec.g, seeded(seed + t), "plain");
        t = rec.deadline;
        if (m) rec.move(m.id, [m.to.r, m.to.c], t);
      }
    }
    return rec.done();
  };
  return [
    // US times out, Italy moves, ... US loses on its third
    mk("timeouts: three in a row lose", ["timeouts"], 5, ["to", "mv", "to", "mv", "to", "mv"]),
    mk("timeouts: a move resets the count", ["timeouts"], 6, ["to", "mv", "to", "mv", "mv", "mv", "to", "mv", "to", "mv"]),
  ];
}

/** The deadline is the turn plus the grace; a move at the edge is accepted, one second later is not. */
function deadlineEdges(): Recording {
  const rec = new Rec("clock: edges of the deadline and of the grace", ["clock", "deadline", "grace"], newGame(seeded(21), START_SEC * 1000, "us", CHAIN_CLOCK));
  const s = START_SEC;
  const m1 = botMove(rec.g, seeded(1), "plain")!;
  const o = CHAIN_CLOCK.openingGraceMs / 1000; // the opening turn only: the first mover is still loading
  rec.timeout(s + 5); // inside the turn
  rec.timeout(s + 6); // the usual deadline (turn + grace) has passed, the opening grace has not: not yet
  rec.timeout(s + o + 5); // inside the turn plus the opening grace
  rec.timeout(s + o + 6); // exactly at the opening deadline: not yet
  rec.move(m1.id, [m1.to.r, m1.to.c], s + o + 7); // one second late
  rec.move(m1.id, [m1.to.r, m1.to.c], s + o + 6); // exactly at the edge: accepted
  const m2 = botMove(rec.g, seeded(2), "plain")!;
  rec.move(m2.id, [m2.to.r, m2.to.c], s + o + 13); // one second after the new deadline: no opening grace any more
  rec.timeout(s + o + 13); // the turn passes
  const m3 = botMove(rec.g, seeded(3), "plain")!;
  rec.move(m3.id, [m3.to.r, m3.to.c], s + o + 18); // inside the grace window
  return rec.done();
}

/** Two Recons each, circling a 2x2 block, so a Match can run as long as the caps allow. */
function circlers(extraUs: L[], extraIt: L[]): L[] {
  return [["us", "2", 7, 0], ["it", "2", 2, 0], ...extraUs, ...extraIt];
}
const usLoop: [number, number][] = [[7, 1], [8, 1], [8, 0], [7, 0]];
const itLoop: [number, number][] = [[2, 1], [1, 1], [1, 0], [2, 0]];

/** The time cap (15 minutes): moves exactly at the cap are accepted, later ones are refused and a timeout ends the Match on the tiebreak. */
function timeCap(variant: "sum" | "count" | "draw"): Recording {
  const extraUs: L[] = variant === "sum" ? [["us", "9", 9, 9]] : variant === "count" ? [["us", "B", 9, 9]] : [];
  const rec = begin(`time cap: tiebreak ${variant}`, ["cap", "time-cap", `tiebreak-${variant}`, "cap-edge"], circlers(extraUs, []));
  const us = startIndex(7, 0);
  const it = startIndex(2, 0);
  for (let k = 1; k <= 150; k++) {
    const side = k % 2 === 1 ? us : it;
    const loop = k % 2 === 1 ? usLoop : itLoop;
    rec.move(side, loop[Math.floor((k - 1) / 2) % 4], START_SEC + 6 * k);
  }
  rec.move(us, usLoop[3], START_SEC + 901); // the cap has passed
  rec.timeout(START_SEC + 901); // ends the Match on the tiebreak
  return rec.done();
}

/** 200 moves: the cap fires with the storm and with a side left without a move. */
function moveCap(name: string, tags: string[], o: { stormAt: number; capture: boolean; extraIt: L[]; extraUs: L[] }): Recording {
  const rec = begin(name, ["cap", "move-cap", ...tags], circlers(o.extraUs, o.extraIt), { stormAt: o.stormAt, stormSeed: 77 });
  const us = startIndex(7, 0);
  const it = startIndex(2, 0);
  for (let k = 1; k <= MOVE_CAP; k++) {
    if (k % 2 === 1) rec.move(us, usLoop[Math.floor((k - 1) / 2) % 4], START_SEC + k);
    else if (o.capture && k === MOVE_CAP) rec.move(it, [7, 0], START_SEC + k);
    else rec.move(it, itLoop[Math.floor((k - 2) / 2) % 4], START_SEC + k);
  }
  return rec.done();
}

/** Italy cannot move at all: the first turn ends with the storm and the stuck check together. */
function stormAndStuck(): Recording {
  const rec = begin("storm and no legal move together", ["storm", "stuck", "storm-stuck"], [
    ["us", "2", 7, 0], ["us", "B", 9, 8], ["us", "B", 9, 9], ["it", "B", 0, 1], ["it", "B", 1, 3],
  ], { stormAt: 1, stormSeed: 3 });
  rec.move(startIndex(7, 0), [6, 0], 1);
  return rec.done();
}

/** Two pieces in a row, the only line that qualifies: they both stay when the storm blows toward the edge, both move the other way. */
function stormStay(): Recording[] {
  const out: Recording[] = [];
  const found: Record<string, boolean> = {};
  for (let seed = 1; seed < 40 && Object.keys(found).length < 2; seed++) {
    const rec = begin(`storm: row of two, seed ${seed}`, ["storm"], [
      ["us", "B", 9, 8], ["us", "B", 9, 9], ["us", "2", 8, 0], ["it", "2", 0, 2], ["it", "B", 1, 3],
    ], { stormAt: 1, stormSeed: seed });
    rec.move(startIndex(8, 0), [7, 0], 1);
    const storm = rec.actions[0].expect.ok ? rec.actions[0].expect.events.find((e) => e.kind === "storm") : undefined;
    if (!storm || storm.kind !== "storm" || storm.axis !== "row" || storm.index !== 9) continue;
    const key = String(storm.dir);
    if (found[key]) continue;
    found[key] = true;
    const done = rec.done();
    done.tags.push(storm.shifts.length === 0 ? "storm-stay" : "storm-move");
    out.push(done);
  }
  return out;
}

const any = () => true;
const at = (r: number, c: number) => (x: Square) => x.r === r && x.c === c;

/** The Sergeant (bishop) and the Captain (king). */
function sergeantAndCaptain(): Recording[] {
  const out: Recording[] = [];
  {
    const rec = begin("sergeant: runs, takes by a run, never straight, claims the depot by a diagonal step, one square in a Two-Step Turn", ["sergeant", "diagonal-run", "diagonal-claim", "raid", "two-step", "refuse-all"], [["us", "4", 9, 1], ["it", "1", 2, 2]], { dummies: true });
    const S = rec.at(9, 1);
    let t = 1;
    rec.refuseAll(S, t++);
    rec.go(S, t++, at(5, 5));
    rec.dummy("it", t++);
    rec.go(S, t++, (x) => x.attack);
    rec.dummy("it", t++);
    for (const [r, c] of [[1, 3], [2, 4], [1, 5]]) {
      rec.go(S, t++, at(r, c));
      rec.dummy("it", t++);
    }
    rec.twoStep(t++);
    rec.refuseAll(S, t++);
    rec.go(S, t++, any);
    rec.dummy("us", t++);
    out.push(rec.done());
  }
  {
    const rec = begin("sergeant: blocked by its own piece, a wadi and the first enemy", ["sergeant", "diagonal-run", "refuse-all"], [["us", "4", 8, 3], ["us", "B", 6, 5], ["it", "9", 6, 1], ["it", "1", 3, 6]], { dummies: true });
    const S = rec.at(8, 3);
    let t = 1;
    rec.refuseAll(S, t++);
    rec.go(S, t++, at(7, 4)); // north-east: the run stops before its own Landmine
    rec.dummy("it", t++);
    rec.go(S, t++, at(8, 3));
    rec.dummy("it", t++);
    rec.go(S, t++, (x) => x.attack); // north-west: the first enemy on the line is a 9, which wins
    out.push(rec.done());
  }
  for (const [name, start, enemy] of [["captain: all eight steps, takes diagonally", [6, 4], [5, 5]], ["captain: shuttle ban on a diagonal pair", [3, 4], [8, 8]]] as const) {
    const rec = begin(name, ["captain", "king-step", "refuse-all"], [["us", "6", start[0], start[1]], ["us", "B", 7, 4], ["it", "1", enemy[0], enemy[1]]], { dummies: true });
    const C = rec.at(start[0], start[1]);
    let t = 1;
    rec.refuseAll(C, t++);
    if (name.includes("all eight")) {
      rec.go(C, t++, (x) => x.attack);
      rec.dummy("it", t++);
      rec.go(C, t++, (x) => x.r !== rec.piece(C).r && x.c !== rec.piece(C).c); // a diagonal step
    } else {
      rec.go(C, t++, at(2, 5));
      rec.dummy("it", t++);
    }
    out.push(rec.done());
  }
  {
    const rec = begin("captain: claims the depot by a diagonal step and may not shuttle across it", ["captain", "diagonal-claim", "raid", "shuttle", "two-step", "refuse-all"], [["us", "6", 2, 4]], { dummies: true });
    const C = rec.at(2, 4);
    let t = 1;
    rec.go(C, t++, at(1, 5));
    rec.dummy("it", t++);
    rec.go(C, t++, at(2, 4));
    rec.dummy("it", t++);
    rec.go(C, t++, at(1, 5));
    rec.dummy("it", t++);
    rec.refuseAll(C, t++); // (2,4) is banned now
    rec.twoStep(t++);
    rec.refuseAll(C, t++);
    rec.go(C, t++, at(0, 4));
    rec.go(C, t++, any);
    out.push(rec.done());
  }
  return out;
}

/** The Lieutenant's jump: every middle piece against every landing. */
function lieutenant(): Recording[] {
  const out: Recording[] = [];
  const middles: [string, Free][] = [
    ["own mine", ["us", "B", 6, 5]], ["enemy mine", ["it", "B", 6, 5]], ["own truck", ["us", "F", 6, 5]], ["enemy truck", ["it", "F", 6, 5]], ["own 9", ["us", "9", 6, 5]], ["enemy recon", ["it", "2", 6, 5]],
  ];
  const landings: [string, Free | null][] = [
    ["empty", null], ["enemy spy", ["it", "1", 5, 5]], ["enemy 9", ["it", "9", 5, 5]], ["enemy mine", ["it", "B", 5, 5]], ["enemy truck", ["it", "F", 5, 5]], ["enemy 5", ["it", "5", 5, 5]], ["own recon", ["us", "2", 5, 5]],
  ];
  middles.forEach(([mname, mid], mi) => {
    landings.forEach(([lname, land], li) => {
      const rec = begin(`lieutenant: jumps over ${mname} onto ${lname}`, ["lieutenant", "jump"], [["us", "5", 7, 5], mid, ...(land ? [land] : [])], { dummies: true });
      const L = rec.at(7, 5);
      let t = 1;
      if (mi === 0 && li === 0) rec.refuseAll(L, t++);
      else rec.refuseAll(L, t++, 23);
      if (rec.reach(L).some(at(5, 5))) {
        rec.go(L, t++, at(5, 5));
        rec.dummy("it", t++);
        if (!rec.g.winner && rec.g.pieces.some((p) => p.id === L)) rec.refuseAll(L, t++, 31);
      }
      out.push(rec.done());
    });
  });
  {
    const rec = begin("lieutenant: a jump onto the depot does not claim it; a jump back is a shuttle", ["lieutenant", "jump", "depot", "shuttle", "refuse-all"], [["us", "5", 3, 5], ["it", "2", 2, 5], ["it", "B", 3, 4]], { dummies: true });
    const L = rec.at(3, 5);
    let t = 1;
    rec.go(L, t++, at(1, 5));
    rec.dummy("it", t++);
    rec.refuseAll(L, t++);
    out.push(rec.done());
  }
  {
    const rec = begin("lieutenant: no jump in a Two-Step Turn, over nobody, off the board or into a wadi", ["lieutenant", "jump", "two-step", "refuse-all"], [["us", "5", 2, 5], ["us", "B", 3, 5], ["us", "B", 0, 5], ["it", "1", 2, 4]], { dummies: true });
    const L = rec.at(2, 5);
    let t = 1;
    rec.refuseAll(L, t++, 3);
    rec.go(L, t++, at(1, 5)); // a step onto the depot: raid, a Two-Step Turn banked
    rec.dummy("it", t++);
    rec.twoStep(t++);
    rec.refuseAll(L, t++);
    rec.go(L, t++, any);
    out.push(rec.done());
  }
  {
    const rec = begin("lieutenant: from the edge and the corner", ["lieutenant", "jump", "refuse-all"], [["us", "5", 9, 0], ["us", "B", 9, 1], ["us", "B", 8, 0]], { dummies: true });
    const L = rec.at(9, 0);
    let t = 1;
    rec.refuseAll(L, t++);
    rec.go(L, t++, any);
    out.push(rec.done());
  }
  return out;
}

/** The General's wadi crossing from every face of both wadis, onto an empty square, an enemy and an own piece. */
function general(): Recording[] {
  const out: Recording[] = [];
  const faces: [number, number, number, number][] = [];
  for (const c of [2, 3, 6, 7]) {
    faces.push([3, c, 6, c], [6, c, 3, c]);
  }
  for (const r of [4, 5]) {
    faces.push([r, 1, r, 4], [r, 4, r, 1], [r, 5, r, 8], [r, 8, r, 5]);
  }
  faces.forEach(([fr, fc, tr, tc], i) => {
    const landing: Free | null = i % 4 === 1 ? ["it", "5", tr, tc] : i % 4 === 2 ? ["us", "2", tr, tc] : null;
    const rec = begin(`general: crosses the wadi ${fr},${fc} to ${tr},${tc}${landing ? ` over ${landing[0] === "it" ? "an enemy" : "its own piece"}` : ""}`, ["general", "crossing", "refuse-all"], [["us", "9", fr, fc], ...(landing ? [landing] : [])], { dummies: true });
    const G = rec.at(fr, fc);
    let t = 1;
    rec.refuseAll(G, t++, i % 4 === 0 ? 1 : 17);
    if (rec.reach(G).some(at(tr, tc))) {
      rec.go(G, t++, at(tr, tc));
      rec.dummy("it", t++);
      rec.refuseAll(G, t++, 29);
    }
    out.push(rec.done());
  });
  {
    const rec = begin("general: no crossing in a Two-Step Turn", ["general", "crossing", "two-step", "refuse-all"], [["us", "9", 3, 2], ["us", "2", 2, 5]], { dummies: true });
    const G = rec.at(3, 2);
    let t = 1;
    rec.go(rec.at(2, 5), t++, at(1, 5)); // a step onto the depot: raid, a Two-Step Turn banked
    rec.dummy("it", t++);
    rec.twoStep(t++);
    rec.refuseAll(G, t++);
    rec.go(G, t++, any);
    rec.dummy("us", t++);
    out.push(rec.done());
  }
  return out;
}

/** Blast: random neighbourhoods at the corner, an edge and the middle, and everything it must refuse. */
function blasts(): Recording[] {
  const out: Recording[] = [];
  const spots: [number, number][] = [[9, 0], [0, 9], [4, 9], [6, 4], [3, 5], [4, 1], [5, 8], [5, 4]];
  const ranks: Rank[] = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "B", "F"];
  spots.forEach(([r, c], i) => {
    const rnd = seeded(500 + i);
    const nb: Free[] = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if ((!dr && !dc) || nr < 0 || nr > 9 || nc < 0 || nc > 9 || isWadi(nr, nc) || rnd() < 0.3) continue;
        nb.push([rnd() < 0.5 ? "us" : "it", ranks[Math.floor(rnd() * ranks.length)], nr, nc]);
      }
    const rec = begin(`blast: at ${r},${c} with ${nb.length} neighbours`, ["blast", "blast-corner", "blast-edge"].slice(0, 1).concat(r % 9 === 0 && c % 9 === 0 ? ["blast-corner"] : r === 0 || c === 0 || r === 9 || c === 9 ? ["blast-edge"] : ["blast-middle"]), [["us", "3", r, c], ...nb], { dummies: true, stormAt: i % 2 ? 1 : 999, stormSeed: 40 + i });
    const E = rec.at(r, c);
    let t = 1;
    rec.act("blast", E, t++, i === 3);
    if (!rec.g.winner) rec.dummy("it", t++);
    if (!rec.g.winner) rec.dummy("us", t++);
    out.push(rec.done());
  });
  {
    const rec = begin("blast: refused for anything but a live Engineer of the side to move, and in a Two-Step Turn or after a step", ["blast", "refuse", "two-step", "blast-refused"], [["us", "9", 6, 4], ["us", "3", 2, 5], ["it", "3", 2, 0], ["it", "1", 3, 4]], { dummies: true });
    const N = rec.at(6, 4);
    const E = rec.at(2, 5);
    const IE = rec.at(2, 0);
    let t = 1;
    rec.act("blast", N, t++); // not an Engineer
    rec.act("blast", IE, t++); // the enemy's
    rec.act("blast", 99, t++); // nobody
    rec.act("blast", 7, t++); // nobody (a free number)
    rec.go(E, t++, at(1, 5)); // a step: raid, Two-Step banked
    rec.dummy("it", t++);
    rec.twoStep(t++);
    rec.act("blast", E, t++); // not in a Two-Step Turn
    rec.go(E, t++, at(2, 5));
    rec.act("blast", E, t++); // not after a step
    rec.dummy("us", t++);
    out.push(rec.done());
  }
  {
    const rec = begin("blast: an Engineer next to another Engineer and the Truck, then late", ["blast", "late"], [["us", "3", 8, 3], ["us", "3", 8, 4], ["us", "F", 9, 3], ["it", "3", 7, 3]], { dummies: true });
    const E = rec.at(8, 3);
    rec.act("blast", E, rec.deadline + 1); // too late
    rec.timeout(rec.deadline + 1);
    out.push(rec.done());
  }
  return out;
}

/** Rescue. */
function rescues(): Recording[] {
  const out: Recording[] = [];
  for (const fuel of [0, 2, 3]) {
    const rec = begin(`rescue: Truck with fuel ${fuel}${fuel === 3 ? ", already Spotted" : ""}, then the enemy takes it`, ["rescue", "truck-captured"], [["us", "8", 5, 4], ["us", "F", 9, 0, undefined, fuel === 3, fuel], ["it", "2", 1, 4]], { dummies: true });
    const K = rec.at(5, 4);
    let t = 1;
    rec.act("rescue", K, t++);
    rec.go(rec.at(1, 4), t++, at(5, 4)); // the Recon runs down the column and takes the Truck
    out.push(rec.done());
  }
  {
    const rec = begin("rescue: after a Truck move, the Colonel beside the Truck, onto the depot, then a storm", ["rescue", "storm", "depot", "truck-moves-again"], [["us", "8", 1, 5], ["us", "F", 8, 5], ["it", "2", 1, 9]], { dummies: true, stormAt: 2, stormSeed: 9 });
    const K = rec.at(1, 5);
    const F = rec.at(8, 5);
    let t = 1;
    rec.go(F, t++, at(7, 5));
    rec.dummy("it", t++);
    rec.act("rescue", K, t++);
    rec.dummy("it", t++);
    rec.go(F, t++, any);
    rec.dummy("it", t++);
    rec.refuseAll(F, t++, 13);
    out.push(rec.done());
  }
  {
    const rec = begin("rescue: the Colonel stands next to the Truck", ["rescue"], [["us", "8", 8, 5], ["us", "F", 8, 6], ["it", "2", 1, 9]], { dummies: true });
    rec.act("rescue", rec.at(8, 5), 1);
    out.push(rec.done());
  }
  {
    const rec = begin("rescue: refused without a Truck and for a stranger's or a wrong-rank piece", ["rescue", "rescue-refused", "refuse"], [["us", "8", 2, 4], ["us", "9", 6, 4], ["it", "8", 2, 0]], { dummies: true });
    const K = rec.at(2, 4);
    let t = 1;
    rec.act("rescue", K, t++); // no Truck
    rec.act("rescue", rec.at(6, 4), t++);
    rec.act("rescue", rec.at(2, 0), t++);
    out.push(rec.done());
  }
  {
    const rec = begin("rescue: refused in a Two-Step Turn and after a step", ["rescue", "rescue-refused", "two-step"], [["us", "8", 2, 5], ["us", "F", 9, 0]], { dummies: true });
    const K = rec.at(2, 5);
    let t = 1;
    rec.go(K, t++, at(1, 5));
    rec.dummy("it", t++);
    rec.twoStep(t++);
    rec.act("rescue", K, t++);
    rec.go(K, t++, at(2, 5));
    rec.act("rescue", K, t++);
    out.push(rec.done());
  }
  return out;
}

/** Dig in (a pass that names a Major), passes, and what they do to the missed-turn count. */
function digAndPass(): Recording[] {
  const out: Recording[] = [];
  {
    const rec = begin("pass: plain passes are missed turns, a move resets them, three in a row lose", ["pass", "pass-loss", "timeouts"], [["us", "7", 8, 1]], { dummies: true });
    let t = 1;
    rec.pass(t++);
    rec.dummy("it", t++);
    rec.pass(t++);
    rec.dummy("it", t++);
    rec.dummy("us", t++); // resets
    rec.dummy("it", t++);
    rec.pass(t++);
    rec.dummy("it", t++);
    rec.pass(t++);
    rec.dummy("it", t++);
    rec.pass(t++); // third: loses
    rec.pass(t++); // after the end
    out.push(rec.done());
  }
  {
    const rec = begin("pass: passes and timeouts mix to three", ["pass", "pass-loss", "timeouts", "pass-timeout-mix"], [["us", "7", 8, 1]], { dummies: true });
    let t = 1;
    rec.pass(t++);
    rec.dummy("it", t++);
    t = rec.deadline + 1;
    rec.timeout(t);
    rec.dummy("it", t++);
    rec.pass(t++, { digIn: 38 }); // a Dig in is a pass too
    out.push(rec.done());
  }
  {
    const rec = begin("pass: timeout, pass, timeout in the other order; a Blast resets", ["pass", "pass-loss", "timeouts", "pass-timeout-mix"], [["us", "3", 8, 1]], { dummies: true });
    let t = 1;
    t = rec.deadline + 1;
    rec.timeout(t);
    rec.dummy("it", t++);
    rec.pass(t++);
    rec.dummy("it", t++);
    rec.act("blast", rec.at(8, 1), t++); // resets
    rec.dummy("it", t++);
    rec.pass(t++);
    out.push(rec.done());
  }
  {
    // every kind of sealed dig-in value: each is a plain pass, and a move in between keeps the count from reaching three
    const rec = begin("dig in: valid, invalid values, already dug, a stranger's and an absent piece", ["dig-in", "pass", "invalid-dig-in"], [["us", "7", 8, 1], ["us", "7", 8, 2], ["us", "9", 8, 3], ["it", "7", 1, 1]], { dummies: true });
    const M1 = rec.at(8, 1);
    const N = rec.at(8, 3);
    const IM = rec.at(1, 1);
    let t = 1;
    for (const v of [N, IM, 255, 200, 29, 60, 0, 31, M1, M1]) {
      rec.pass(t++, { digIn: v });
      rec.dummy("it", t++);
      rec.dummy("us", t++);
      rec.dummy("it", t++);
    }
    out.push(rec.done());
  }
  {
    const rec = begin("dig in: a dug-in Major is a Landmine: it cannot move and beats an attacker", ["dig-in", "pass", "dug-attacked"], [["us", "7", 8, 1], ["it", "9", 2, 1], ["it", "2", 1, 9]], { dummies: true });
    const M = rec.at(8, 1);
    const I = rec.at(2, 1);
    let t = 1;
    rec.pass(t++, { digIn: M });
    rec.go(I, t++, at(3, 1));
    rec.dummy("us", t++);
    for (const r of [4, 5, 6, 7]) {
      rec.go(I, t++, at(r, 1));
      rec.dummy("us", t++);
    }
    rec.go(I, t++, at(8, 1)); // the 9 attacks the dug-in Major: a Landmine
    rec.move(M, [7, 1], t++); // it is gone / or not the turn
    out.push(rec.done());
  }
  for (let seed = 1; seed < 400; seed++) {
    const rec = begin("dig in: a dug-in Major drifts in the storm like any Landmine", ["dig-in", "pass", "storm", "dug-storm"], [["us", "7", 8, 8], ["us", "B", 8, 9], ["us", "9", 9, 4]], { stormAt: 2, stormSeed: seed, dummies: true });
    const M = rec.at(8, 8);
    let t = 1;
    rec.pass(t++, { digIn: M });
    rec.dummy("it", t++);
    rec.dummy("us", t++);
    rec.dummy("it", t++);
    const storm = rec.actions.flatMap((a) => (a.expect.ok ? a.expect.events : [])).find((e) => e.kind === "storm");
    if (storm?.kind === "storm" && storm.shifts.some((x) => x.id === M)) {
      out.push(rec.done());
      break;
    }
  }
  {
    const rec = begin("dig in: a face-up Major (shown by a Blast) digs in in the open", ["dig-in", "pass", "dug-in-face-up", "blast"], [["us", "7", 8, 1], ["it", "3", 7, 1], ["it", "2", 1, 9]], { dummies: true });
    const M = rec.at(8, 1);
    const E = rec.at(7, 1);
    let t = 1;
    rec.dummy("us", t++);
    rec.act("blast", E, t++); // the enemy Engineer shows my Major (and itself goes)
    rec.pass(t++, { digIn: M });
    rec.go(rec.at(1, 9), t++, any);
    rec.dummy("us", t++);
    out.push(rec.done());
  }
  {
    const rec = begin("dig in: refused as a pass inside a Two-Step Turn and after a step", ["pass", "pass-refused", "two-step"], [["us", "7", 2, 5]], { dummies: true });
    const M = rec.at(2, 5);
    let t = 1;
    rec.go(M, t++, at(1, 5));
    rec.dummy("it", t++);
    rec.twoStep(t++);
    rec.pass(t++);
    rec.pass(t++, { digIn: M });
    rec.go(M, t++, at(2, 5));
    rec.pass(t++);
    out.push(rec.done());
  }
  {
    const rec = begin("pass: the move cap is untouched by passes and the clock is checked", ["pass", "late"], [["us", "7", 8, 1]], { dummies: true });
    let t = 1;
    rec.pass(rec.deadline + 1); // too late
    rec.pass(t++);
    rec.pass(START_SEC + 901); // the cap passed
    out.push(rec.done());
  }
  return out;
}

/** Become a Spy. */
function switches(): Recording[] {
  const out: Recording[] = [];
  {
    const rec = begin("switch: with a move, with a Dig in, a second action after the change, and a switch with no General of the Army", ["switch", "second-action"], [["us", "10", 8, 1], ["us", "7", 8, 2], ["it", "2", 1, 9], ["it", "10", 2, 0]], { dummies: true });
    const T = rec.at(8, 1);
    const M = rec.at(8, 2);
    let t = 1;
    rec.dummy("us", t++, true); // the switch rides on a dummy's move
    rec.dummy("it", t++, true);
    rec.pass(t++, { digIn: M, sw: true }); // already switched: nothing; a Dig in
    rec.dummy("it", t++);
    rec.go(T, t++, any, true); // a second action after the changes
    rec.dummy("it", t++);
    rec.go(T, t++, any);
    out.push(rec.done());
  }
  {
    const rec = begin("switch: a refused action does not switch; the next fight shows the 10", ["switch", "switch-refused"], [["us", "10", 6, 0], ["it", "10", 5, 0], ["it", "2", 1, 9]], { dummies: true });
    const T = rec.at(6, 0);
    let t = 1;
    rec.move(T, [2, 0], t++, true); // illegal: switch is not applied
    rec.go(T, t++, (x) => x.attack, false); // the 10s trade
    out.push(rec.done());
  }
  {
    const rec = begin("switch: a switched 10 beats the 10 it attacks in the same action, and beats the 10 that attacks it", ["switch", "switch-attack"], [["us", "10", 6, 0], ["it", "10", 5, 0], ["it", "2", 1, 9]], { dummies: true });
    const T = rec.at(6, 0);
    rec.go(T, 1, (x) => x.attack, true);
    out.push(rec.done());
  }
  {
    const rec = begin("switch: the other way round, the Italian 10 attacks a switched 10", ["switch", "switch-attack"], [["us", "10", 6, 0], ["it", "10", 5, 0], ["it", "2", 1, 9]], { dummies: true, first: "us" });
    const IT10 = rec.at(5, 0);
    let t = 1;
    rec.dummy("us", t++, true);
    rec.go(IT10, t++, (x) => x.attack);
    out.push(rec.done());
  }
  {
    const rec = begin("switch: a face-up 10 switches in the open", ["switch", "switched-face-up", "blast"], [["us", "10", 8, 1], ["it", "3", 7, 1], ["it", "2", 1, 9]], { dummies: true });
    const E = rec.at(7, 1);
    let t = 1;
    rec.dummy("us", t++);
    rec.act("blast", E, t++); // shows the 10
    rec.dummy("us", t++, true); // a known 10 switches: named
    rec.go(rec.at(1, 9), t++, any);
    out.push(rec.done());
  }
  {
    const rec = begin("switch: with a Blast and a Rescue; a dead General of the Army cannot switch", ["switch", "blast", "rescue"], [["us", "10", 8, 1], ["us", "3", 8, 2], ["us", "8", 8, 3], ["us", "F", 9, 0], ["it", "2", 1, 9], ["it", "2", 0, 5]], { dummies: true });
    let t = 1;
    rec.act("blast", rec.at(8, 2), t++, true);
    rec.dummy("it", t++);
    rec.act("rescue", rec.at(8, 3), t++, true); // already switched
    rec.dummy("it", t++);
    out.push(rec.done());
  }
  return out;
}

/** Endings with the new actions. */
function endings(): Recording[] {
  const out: Recording[] = [];
  {
    // Italy has only Landmines and a Major: it can dig in, so it is not stuck; after digging in it is
    const rec = begin("end: a side with only a Major left can still act; once dug in with nothing else, it is stuck", ["stuck", "has-action", "dig-in"], [["us", "2", 7, 0], ["it", "7", 0, 0], ["it", "B", 0, 2], ["it", "B", 1, 2]], { stormAt: 999 });
    const M = rec.at(0, 0);
    let t = 1;
    rec.go(rec.at(7, 0), t++, any);
    rec.go(M, t++, at(0, 1));
    rec.go(rec.at(7, 0), t++, any);
    rec.go(M, t++, at(0, 0));
    rec.go(rec.at(7, 0), t++, any);
    rec.pass(t++, { digIn: M });
    rec.go(rec.at(7, 0), t++, any);
    out.push(rec.done());
  }
  for (const [name, rank, act] of [["a boxed-in Major digs in", "7", "dig"], ["a boxed-in Engineer blasts", "3", "blast"], ["a boxed-in Colonel rescues its boxed-in Truck", "8", "rescue"], ["a boxed-in Colonel with no Truck has no action", "8", "none"]] as const) {
    // Italy has a piece that cannot step but can act: not stuck. After it acted there is nothing left: stuck.
    const rec = begin(`end: ${name}, then the side has nothing left and is stuck`, ["stuck", "has-action", ...(act === "dig" ? ["dig-in"] : act === "none" ? [] : [act])], [
      ["us", "2", 7, 0], ["it", rank, 0, 0], ["it", "B", 0, 1], ["it", "B", 1, 0], ["it", "B", 1, 1],
      ...(act === "rescue" ? ([["it", "F", 0, 9], ["it", "B", 0, 8], ["it", "B", 1, 8], ["it", "B", 1, 9]] as Free[]) : []),
    ]);
    const P = rec.at(0, 0);
    let t = 1;
    const loop: [number, number][] = [[7, 1], [8, 1], [8, 0], [7, 0]];
    let k = 0;
    const us = () => rec.move(rec.at(7, 0), loop[k++ % 4], t++);
    us();
    if (act === "dig") rec.pass(t++, { digIn: P });
    else if (act !== "none") rec.act(act, P, t++);
    if (act !== "none") us();
    out.push(rec.done());
  }
  {
    // Two-Step Turn with only a Blast left after the first step: the Turn ends with the step
    const rec = begin("end: a Blast alone keeps a side alive and a Two-Step Turn continues for a step", ["two-step", "has-step", "has-action", "blast"], [["us", "6", 2, 4], ["us", "3", 9, 9], ["it", "B", 0, 0], ["it", "3", 0, 1]]);
    let t = 1;
    rec.go(rec.at(2, 4), t++, at(1, 5));
    rec.act("blast", rec.at(0, 1), t++);
    rec.twoStep(t++);
    rec.go(rec.at(2, 4), t++, any);
    out.push(rec.done());
  }
  for (const [name, extraUs, extraIt] of [
    ["end: the time cap counts a dug-in Major as a Landmine", [["us", "7", 9, 9]], [["it", "6", 0, 9]]],
    ["end: the time cap counts a switched General of the Army as a Spy", [["us", "10", 9, 9]], [["it", "3", 0, 9]]],
  ] as [string, Free[], Free[]][]) {
    const rec = begin(name, ["cap", "time-cap", "cap-changed", "cap-edge"], circlers(extraUs, extraIt), { stormAt: 999 });
    const us = startIndex(7, 0);
    const it = startIndex(2, 0);
    const piece = extraUs[0][1] === "7" ? { digIn: rec.at(9, 9) } : { sw: true };
    for (let k = 1; k <= 12; k++) {
      if (k === 1) rec.pass(START_SEC + 6 * k, piece);
      else rec.move(k % 2 === 1 ? us : it, (k % 2 === 1 ? usLoop : itLoop)[Math.floor((k - 1) / 2) % 4], START_SEC + 6 * k);
    }
    rec.timeout(START_SEC + 901);
    out.push(rec.done());
  }
  return out;
}

/** Rules version 5: the old movement, the Engineer's defuse and none of the new actions. */
function version5(): Recording[] {
  const out: Recording[] = [];
  {
    const rec = begin("v5: an Engineer defuses, nothing moves diagonally or jumps, and the new actions are refused", ["v5", "defuse", "refuse-all"], [["us", "3", 7, 0], ["us", "4", 9, 1], ["us", "6", 8, 5], ["us", "5", 9, 5], ["us", "9", 3, 2], ["us", "B", 8, 6], ["it", "B", 3, 0], ["it", "2", 1, 9], ["it", "10", 2, 2]], { dummies: true, version: 5 });
    const E = rec.at(7, 0);
    let t = 1;
    rec.act("blast", E, t++);
    rec.act("rescue", rec.at(9, 5), t++);
    rec.pass(t++);
    rec.pass(t++, { digIn: rec.at(8, 5) });
    for (const id of [rec.at(9, 1), rec.at(8, 5), rec.at(9, 5), rec.at(3, 2)]) rec.refuseAll(id, t++, 9);
    rec.move(rec.at(9, 1), [8, 1], t++, true); // a Sergeant steps straight on version 5; the switch is ignored
    rec.dummy("it", t++);
    rec.go(E, t++, at(6, 0));
    rec.dummy("it", t++);
    rec.go(E, t++, at(5, 0));
    rec.dummy("it", t++);
    rec.go(E, t++, at(4, 0));
    rec.dummy("it", t++);
    rec.go(E, t++, at(3, 0)); // defuses
    out.push(rec.done());
  }
  return out;
}

/** One position with the targets the TypeScript rules give every piece of the side to move. The Rust engine must give the same. */
export interface PositionRec {
  name: string;
  version: number;
  turn: Army;
  turnNo: number;
  twoStepActive: boolean;
  moved: number[];
  /** Per army (us, it): the turn the Truck last moved on. */
  truckTurn: [number, number];
  /** `<army>:<rank>:<row>:<col>:<piece number>:<known>:<fuel>`; a changed piece is listed under `changed`. */
  pieces: string[];
  trails: Record<number, string[]>;
  changed: Record<number, "dug" | "spy">;
  expect: { targets: Record<number, string[]>; hasAction: [boolean, boolean]; hasStep: [boolean, boolean] };
}

/** Random positions across every rank, shape, trail, fuel and Two-Step state, for both rule versions. */
export function buildPositions(count = 260): PositionRec[] {
  const rnd = seeded(31337);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const ranks: Rank[] = ROSTER.flatMap(([r, n]) => Array<Rank>(n).fill(r));
  const squares = Array.from({ length: SIZE * SIZE }, (_, i) => [Math.floor(i / SIZE), i % SIZE] as [number, number]).filter(([r, c]) => !isWadi(r, c));
  const near = (r: number, c: number) => squares.filter(([a, b]) => Math.max(Math.abs(a - r), Math.abs(b - c)) <= 1 && (a !== r || b !== c));
  const out: PositionRec[] = [];
  for (let i = 0; i < count; i++) {
    const version = rnd() < 0.2 ? 5 : RULES_VERSION;
    const turn: Army = rnd() < 0.5 ? "us" : "it";
    const free = [...squares].sort(() => rnd() - 0.5);
    const list: Free[] = [];
    // every other position is sparse: few pieces, so stuck sides, lone Engineers, Colonels and Majors, and Truck-only sides show up
    const sparse = i % 2 === 1;
    // the shapes get a piece of the side to move most of the time, next to a wadi half of the time
    for (const rank of ["4", "5", "6", "9", "2", "F"] as Rank[]) {
      if (rnd() < (sparse ? 0.2 : 0.85)) {
        const sq = rank === "9" && rnd() < 0.6 ? pick(squares.filter(([r, c]) => (r === 3 || r === 6) && [2, 3, 6, 7].includes(c) || (r === 4 || r === 5) && [1, 4, 5, 8].includes(c))) : free.pop()!;
        const k = free.findIndex(([r, c]) => r === sq[0] && c === sq[1]);
        if (k >= 0) free.splice(k, 1);
        if (!list.some((p) => p[2] === sq[0] && p[3] === sq[1])) list.push([turn, rank, sq[0], sq[1]]);
      }
    }
    const rest = sparse ? Math.floor(rnd() * 7) : 4 + Math.floor(rnd() * 34);
    for (let k = 0; k < rest; k++) {
      const sq = free.pop()!;
      if (list.some((p) => p[2] === sq[0] && p[3] === sq[1])) continue;
      list.push([rnd() < 0.5 ? "us" : "it", pick(ranks), sq[0], sq[1]]);
    }
    // army sizes stay within the thirty slots
    const placed = place(list.filter((p, _, all) => all.filter((q) => q[0] === p[0]).indexOf(p) < 30));
    for (const p of placed) {
      if (p.rank === "F") p.fuel = Math.floor(rnd() * 4);
      if (rnd() < 0.15) p.known = true;
      const roll = rnd();
      if (roll < 0.35) {
        const cur: [number, number] = [p.r, p.c];
        const prev = pick(near(cur[0], cur[1]));
        const key = (q: [number, number]) => `${q[0]},${q[1]}`;
        p.trail = roll < 0.18 ? [key(prev), key(cur), key(prev), key(cur)] : Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => key(pick(near(cur[0], cur[1])))).concat(key(cur));
      }
    }
    const changed: Record<number, "dug" | "spy"> = {};
    for (const p of placed) {
      if (p.rank === "7" && rnd() < 0.3) changed[p.id] = "dug";
      if (p.rank === "10" && rnd() < 0.4) changed[p.id] = "spy";
    }
    const turnNo = Math.floor(rnd() * 40);
    const mine = placed.filter((p) => p.army === turn);
    const moved = rnd() < 0.5 ? mine.filter(() => rnd() < 0.25).map((p) => p.id) : [];
    const twoStepActive = rnd() < 0.3;
    const g: Game = {
      ...startGame([], { startedAt: START_SEC * 1000, stormAt: 999, stormSeed: 1, first: turn, clock: CHAIN_CLOCK, version }),
      pieces: placed,
      turn,
      turnNo,
      twoStepActive,
      movedThisTurn: moved,
      truckTurn: { us: pick([-9, turnNo - 2, turnNo - 1, 0, 3]), it: pick([-9, turnNo - 2, turnNo - 1, 1, 4]) },
      changed,
    };
    const tg: Record<number, string[]> = {};
    for (const p of mine) tg[p.id] = targets(g, p).map((x) => `${x.r},${x.c}`).sort();
    out.push({
      name: `position ${i} (v${version}, ${turn}, ${placed.length} pieces${twoStepActive ? ", two-step" : ""})`,
      version,
      turn,
      turnNo,
      twoStepActive,
      moved,
      truckTurn: [g.truckTurn.us, g.truckTurn.it],
      pieces: placed.map(layoutString),
      trails: Object.fromEntries(placed.filter((p) => p.trail.length > 1).map((p) => [p.id, p.trail])),
      changed,
      expect: { targets: tg, hasAction: [hasAction(g, "us"), hasAction(g, "it")], hasStep: [hasStep(g, "us"), hasStep(g, "it")] },
    });
  }
  return out;
}

/** The two sides' raids, seeds and so on all come out of one function so the file is reproducible. */
export function buildRecordings(): Recording[] {
  const bots = [
    ...Array.from({ length: 4 }, (_, i) => botMatch(i + 1)),
    ...Array.from({ length: 9 }, (_, i) => botMatch(i + 101, "standard")),
    ...Array.from({ length: 5 }, (_, i) => botMatch(i + 201, "fortress")),
    ...Array.from({ length: 2 }, (_, i) => botMatch(i + 301, "plain", 5)),
  ];
  const all = [
    ...pairs(),
    ...switchedFights(),
    truckSpotted(),
    depotsAndTwoStep(),
    ...timeouts(),
    deadlineEdges(),
    timeCap("sum"),
    timeCap("count"),
    timeCap("draw"),
    moveCap("move cap: the last move takes the last mobile piece, with the storm", ["storm", "stuck", "storm-cap-stuck", "tiebreak-count"], {
      stormAt: 200, capture: true, extraUs: [["us", "B", 9, 8], ["us", "B", 9, 9]], extraIt: [["it", "F", 0, 4], ["it", "B", 0, 9], ["it", "B", 0, 8]],
    }),
    moveCap("move cap: plain, no storm", ["tiebreak-draw"], { stormAt: 999, capture: false, extraUs: [], extraIt: [] }),
    stormAndStuck(),
    ...stormStay(),
    ...sergeantAndCaptain(),
    ...lieutenant(),
    ...general(),
    ...blasts(),
    ...rescues(),
    ...digAndPass(),
    ...switches(),
    ...endings(),
    ...version5(),
    ...bots,
  ];
  return all;
}

/** The checked-in text: one action per line so a diff stays readable. */
export function serialize(recs: Recording[], positions: PositionRec[]): string {
  const head = {
    description: "Matches played with app/src/games/vanguard/rules.ts under the chain clock, and positions with the targets it gives; the Rust engine replays them. Generated, do not edit.",
    constants: constants(),
  };
  const lines = recs.map((r) => {
    const { actions, ...meta } = r;
    return `{"meta":${JSON.stringify(meta)},"actions":[\n${actions.map((a) => JSON.stringify(a)).join(",\n")}\n]}`;
  });
  return `{"description":${JSON.stringify(head.description)},"constants":${JSON.stringify(head.constants)},"recordings":[\n${lines.join(",\n")}\n],"positions":[\n${positions.map((p) => JSON.stringify(p)).join(",\n")}\n]}\n`;
}
