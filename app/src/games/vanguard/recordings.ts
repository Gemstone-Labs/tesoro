/**
 * Shared recordings: Matches played with the app's rules engine under the chain clock, written to
 * programs/vanguard/tests/fixtures/recordings.json. The program's Rust engine replays every action and must
 * reach the same public board and the same events, or the same refusal. Times are whole seconds, as on the chain.
 *
 * Regenerate with `WRITE_RECORDINGS=1 pnpm --filter @tesoro/app exec vitest run src/games/vanguard/recordings.test.ts`.
 */
import { botMove } from "./practice/bot";
import {
  CAP_MS, CHAIN_CLOCK, DEPOTS, MOVE_CAP, ROSTER, RULES_VERSION, SIZE, STORM_WINDOW, TIMEOUTS_TO_LOSE, TRUCK_FUEL, isWadi, move, newGame, seeded, startGame, startIndex, startTwoStep, timeout,
  type Army, type Game, type GameEvent, type Rank, type Refusal, type Result,
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

export type RecAction =
  | { kind: "move"; id: number; to: [number, number]; at: number; expect: Expect }
  | { kind: "two_step" | "timeout"; at: number; expect: Expect };
export type Expect = { ok: true; events: GameEvent[]; state: PublicState } | { ok: false; reason: Refusal };

export interface Recording {
  name: string;
  tags: string[];
  /** `<army>:<rank>:<row>:<col>` */
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
    board: g.pieces.map((p) => `${p.id}${p.army === "us" ? "u" : "i"}${p.r}${p.c}=${p.known ? p.rank : "?"}`).join(","),
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

/** The game a recording starts from. */
export function startOf(rec: Recording): Game {
  return startGame(
    rec.layout.map((s) => {
      const [army, rank, r, c] = s.split(":");
      return { army: army as Army, rank: rank as Rank, r: Number(r), c: Number(c) };
    }),
    { startedAt: rec.startedAt * 1000, stormAt: rec.stormAt, stormSeed: rec.stormSeed, first: rec.first, clock: CHAIN_CLOCK },
  );
}

/** Run one recorded action on the TS engine. */
export function apply(g: Game, a: RecAction): Result {
  const at = a.at * 1000;
  if (a.kind === "move") return move(g, { id: a.id, to: { r: a.to[0], c: a.to[1] }, at });
  if (a.kind === "two_step") return startTwoStep(g, at);
  return timeout(g, at);
}

export const expectOf = (res: Result): Expect => (res.ok ? { ok: true, events: res.events, state: publicState(res.game) } : { ok: false, reason: res.reason });

class Rec {
  g: Game;
  readonly actions: RecAction[] = [];
  private readonly rec: Omit<Recording, "actions">;
  constructor(name: string, tags: string[], g: Game) {
    this.g = g;
    this.rec = {
      name,
      tags,
      layout: g.pieces.map((p) => `${p.army}:${p.rank}:${p.r}:${p.c}`),
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
  move(id: number, to: [number, number], at: number) {
    return this.run({ kind: "move", id, to, at, expect: null as never });
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
  done(): Recording {
    return { ...this.rec, actions: this.actions };
  }
}

type L = [Army, Rank, number, number];

function begin(name: string, tags: string[], layout: L[], o: { first?: Army; stormAt?: number; stormSeed?: number } = {}): Rec {
  const g = startGame(
    layout.map(([army, rank, r, c]) => ({ army, rank, r, c })),
    { startedAt: START_SEC * 1000, stormAt: o.stormAt ?? 999, stormSeed: o.stormSeed ?? 1, first: o.first ?? "us", clock: CHAIN_CLOCK },
  );
  return new Rec(name, tags, g);
}

const RANKS: Rank[] = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"];
const ALL: Rank[] = [...RANKS, "B", "F"];

/** Every attacker rank against every defender rank: the attacker walks up a column, the Italians shuffle a Recon. */
function pairs(): Recording[] {
  const out: Recording[] = [];
  const dummy: [number, number][] = [[1, 9], [0, 9], [0, 8], [1, 8], [1, 9]];
  const up: [number, number][] = [[6, 0], [5, 0], [4, 0], [3, 0], [2, 0]];
  for (const att of RANKS) {
    for (const def of ALL) {
      const rec = begin(`fight ${att} attacks ${def}`, ["fight"], [["us", att, 7, 0], ["it", def, 2, 0], ["it", "2", 1, 8]]);
      const a = startIndex(7, 0);
      const d = startIndex(1, 8);
      for (let i = 0; i < 5; i++) {
        rec.move(a, up[i], 1 + i * 2);
        rec.move(d, dummy[i], 2 + i * 2);
      }
      out.push(rec.done());
    }
  }
  return out;
}

/** Random full-roster Matches played by the practice bot, with late and refused actions mixed in. */
function botMatch(seed: number): Recording {
  const rng = seeded(seed * 7919 + 13);
  const g0 = newGame(seeded(seed), START_SEC * 1000, rng() < 0.5 ? "us" : "it", CHAIN_CLOCK);
  const rec = new Rec(`bot match ${seed}`, ["bot"], g0);
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
    if (rng() < 0.03) {
      t = rec.deadline + 1;
      const res = rec.timeout(t);
      if (!res.ok) break;
      continue;
    }
    const m = botMove(rec.g, rng, "plain");
    if (!m) break;
    t = Math.min(rec.deadline, t + 1 + Math.floor(rng() * 4));
    if (m.twoStep && !rec.twoStep(t).ok) break;
    if (rng() < 0.03) rec.move(m.id, [m.to.r, m.to.c], rec.deadline + 1);
    if (!rec.move(m.id, [m.to.r, m.to.c], t).ok) break;
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

/** The two sides' raids, seeds and so on all come out of one function so the file is reproducible. */
export function buildRecordings(): Recording[] {
  const bots = Array.from({ length: 10 }, (_, i) => botMatch(i + 1));
  const all = [
    ...pairs(),
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
    ...bots,
  ];
  return all;
}

/** The checked-in text: one action per line so a diff stays readable. */
export function serialize(recs: Recording[]): string {
  const head = {
    description: "Matches played with app/src/games/vanguard/rules.ts under the chain clock; the Rust engine replays them. Generated, do not edit.",
    constants: constants(),
  };
  const lines = recs.map((r) => {
    const { actions, ...meta } = r;
    return `{"meta":${JSON.stringify(meta)},"actions":[\n${actions.map((a) => JSON.stringify(a)).join(",\n")}\n]}`;
  });
  return `{"description":${JSON.stringify(head.description)},"constants":${JSON.stringify(head.constants)},"recordings":[\n${lines.join(",\n")}\n]}\n`;
}
