import { CAP_MS, MOVE_CAP, STORM_WINDOW, TURN_MS, isWadi, onBoard, pieceAt, placeArmy, rankOf, seeded, startGame, startTwoStep, timeout, type Army, type EndReason, type Game, type GameEvent, type Square } from "../rules";
import { applyBot, botMove, type BotAction, type Policy } from "../practice/bot";

/** How long one action takes on a real clock. Thinking and chain time are script parameters; animation comes from the board. */
export interface Pace {
  thinkMinMs: number;
  thinkMaxMs: number;
  /** One transaction on the rollup (ticket 01 replaces this once measured). */
  chainMs: number;
}
export const DEFAULT_PACE: Pace = { thinkMinMs: 2000, thinkMaxMs: 3000, chainMs: 500 };

/** Animation lengths copied from practice/VanguardPractice.tsx (the beats the board plays for each event). */
const slideMs = (a: Square, b: Square) => Math.min(380, 140 + (Math.abs(a.r - b.r) + Math.abs(a.c - b.c)) * 40);
export function animationMs(events: GameEvent[]): number {
  let ms = 0;
  for (const e of events) {
    if (e.kind === "move") ms += slideMs(e.from, e.to);
    else if (e.kind === "attack") {
      const d = Math.abs(e.to.r - e.from.r) + Math.abs(e.to.c - e.from.c);
      const toEdge = Math.min(380, 140 + Math.max(0, d - 0.55) * 40);
      const wins = e.outcome === "win" || e.outcome === "defuse" || e.outcome === "truck";
      ms += toEdge + (e.flash.length ? 820 : 0) + 200 + 300 + (wins ? 160 : 0);
    } else if (e.kind === "spotted" || e.kind === "raid") ms += 500;
    else if (e.kind === "blast" || e.kind === "rescue") ms += 900; // placeholders until ticket 02 builds the animations
    else if (e.kind === "dug_in" || e.kind === "switched") ms += 300;
    else if (e.kind === "storm") ms += 3500;
  }
  return ms;
}

/** A bot policy, or "plain" (movement only, the bot before powers). */
export type Side = Policy | "plain";

export interface MatchOptions {
  first?: Army;
  pace?: Pace;
  /** Which policy each army plays; "standard" for both by default. */
  policies?: Record<Army, Side>;
  /** Rules version to play under (5 = before powers); the current one by default. */
  version?: number;
  /** Move cap and time cap to play under; the rules' own values by default. A huge value probes how long a Match runs uncapped. */
  capMoves?: number;
  capMs?: number;
  onStep?: (g: Game, events: GameEvent[]) => void;
}

/** What a Match counted of each power: the five new actions plus the new movement patterns. */
export const POWERS = ["dig_in", "blast", "rescue", "switch", "sergeant_run", "captain_diagonal", "lieutenant_jump", "general_crossing"] as const;
export type PowerName = (typeof POWERS)[number];
export const POWER_LABEL: Record<PowerName, string> = {
  dig_in: "Dig in (Major)",
  blast: "Blast (Engineer)",
  rescue: "Rescue (Colonel)",
  switch: "Become a Spy (General of the Army)",
  sergeant_run: "Sergeant diagonal run of 2+ squares",
  captain_diagonal: "Captain diagonal step",
  lieutenant_jump: "Lieutenant jump",
  general_crossing: "General wadi crossing",
};

export interface MatchRow {
  seed: number;
  first: Army;
  winner: Army | "draw";
  reason: EndReason;
  cappedBy: "moves" | "time" | null;
  moves: number;
  turns: number;
  wallMs: number;
  /** Moves made before the first attack (null when no attack happened). */
  firstContactMove: number | null;
  stormTurn: number;
  stormFired: boolean;
  stormShifted: number;
  twoStepsSpent: number;
  /** Actions whose think + chain + the opponent's animation would have passed the turn clock that is not rebased. */
  lateWithoutRebase: number;
  /** How many times each power was used in the Match (both armies together). */
  powers: Record<PowerName, number>;
  /** A sealed Truck stood at the start of some turn, per army (see `sealedTrucks`). */
  sealed: Record<Army, boolean>;
}

const T0 = 1_000_000;
const mix = (seed: number, salt: number) => Math.imul(seed ^ salt, 0x9e3779b1) >>> 0;

/**
 * Which armies have a sealed Truck right now (spec "Sealed Truck"): every on-board neighbour square of the Truck holds a Landmine
 * (an original mine or a dug-in Major) or is a wadi, and the enemy has no live Lieutenant.
 */
export function sealedTrucks(g: Game): Record<Army, boolean> {
  const out: Record<Army, boolean> = { us: false, it: false };
  for (const army of ["us", "it"] as const) {
    const truck = g.pieces.find((p) => p.army === army && p.rank === "F");
    if (!truck) continue;
    if (g.pieces.some((p) => p.army !== army && rankOf(g, p) === "5")) continue;
    let sealed = true;
    for (let dr = -1; dr <= 1 && sealed; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = truck.r + dr;
        const c = truck.c + dc;
        if (!onBoard(r, c) || isWadi(r, c)) continue;
        const q = pieceAt(g, r, c);
        if (!q || rankOf(g, q) !== "B") {
          sealed = false;
          break;
        }
      }
    out[army] = sealed;
  }
  return out;
}

const emptyPowers = (): Record<PowerName, number> => Object.fromEntries(POWERS.map((p) => [p, 0])) as Record<PowerName, number>;

/** Which movement power (if any) a bot move uses. */
function movementPower(g: Game, m: Extract<BotAction, { kind: "move" }>): PowerName | null {
  const p = g.pieces.find((q) => q.id === m.id);
  if (!p) return null;
  const rank = rankOf(g, p);
  const dr = m.to.r - p.r;
  const dc = m.to.c - p.c;
  const len = Math.max(Math.abs(dr), Math.abs(dc));
  if (rank === "4" && len >= 2) return "sergeant_run";
  if (rank === "6" && dr && dc) return "captain_diagonal";
  if (rank === "5" && len === 2) return "lieutenant_jump";
  if (rank === "9" && len === 3) return "general_crossing";
  return null;
}

/** A Match from a random layout under the given rules version (the same draws as the rules' `newGame`). */
function startMatch(rng: () => number, first: Army, version: number | undefined): Game {
  const layout = [...placeArmy("it", rng), ...placeArmy("us", rng)];
  const stormAt = STORM_WINDOW.from + Math.floor(rng() * (STORM_WINDOW.to - STORM_WINDOW.from + 1));
  return startGame(layout, { startedAt: T0, stormAt, stormSeed: Math.floor(rng() * 0x100000000), first, version });
}

/** One Match between two bots. Same seed, same Match: the thinking times come from their own stream. */
export function runMatch(seed: number, o: MatchOptions = {}): MatchRow {
  const pace = o.pace ?? DEFAULT_PACE;
  const capMoves = o.capMoves ?? MOVE_CAP;
  const capMs = o.capMs ?? CAP_MS;
  const first = o.first ?? (seed % 2 ? "us" : "it");
  const sides = o.policies ?? { us: "standard", it: "standard" };
  const rng = seeded(mix(seed, 0x1234abcd));
  const time = seeded(mix(seed, 0x5eed7117));
  const base = startMatch(rng, first, o.version);
  // shifting the engine's counters moves its caps without touching the rules
  const moveOffset = MOVE_CAP - capMoves;
  let g: Game = { ...base, startedAt: T0 + capMs - CAP_MS, deadline: T0 + TURN_MS, moves: moveOffset };
  let wall = 0;
  let firstContactMove: number | null = null;
  let stormShifted = 0;
  let twoSteps = 0;
  let late = 0;
  let animBefore = 0;
  let cappedBy: "moves" | "time" | null = null;
  const powers = emptyPowers();
  const sealed = { us: false, it: false };
  const fail = (what: string): never => {
    throw new Error(`seed ${seed}: ${what}`);
  };

  while (!g.winner) {
    const s = sealedTrucks(g);
    sealed.us ||= s.us;
    sealed.it ||= s.it;
    const m = botMove(g, rng, sides[g.turn] as Policy);
    if (!m) {
      const t = timeout(g, g.deadline + 1);
      if (!t.ok) fail(`stuck without a legal move and timeout refused (${t.reason})`);
      else g = t.game;
      continue;
    }
    const think = pace.thinkMinMs + time() * (pace.thinkMaxMs - pace.thinkMinMs);
    if (wall + think + pace.chainMs > capMs) {
      const t = timeout(g, T0 + capMs + 1);
      if (!t.ok) fail(`time cap refused (${t.reason})`);
      else {
        g = t.game;
        cappedBy = "time";
        o.onStep?.(g, t.events);
      }
      break;
    }
    if (animBefore + think + pace.chainMs > TURN_MS) late++;
    wall += think + pace.chainMs;
    // the practice screen rebases the turn clock after each animation; the sim does the same
    g = { ...g, deadline: T0 + wall + TURN_MS };
    if (m.twoStep) {
      const st = startTwoStep(g, T0 + wall);
      if (!st.ok) fail(`two-step refused (${st.reason})`);
      else {
        g = st.game;
        twoSteps++;
        wall += pace.chainMs;
      }
    }
    // counted before the action is applied, from the board the bot saw
    if (m.kind === "move") {
      const mp = movementPower(g, m);
      if (mp) powers[mp]++;
      if (m.switch) powers.switch++;
    } else powers[m.kind]++;
    const r = applyBot(g, m, T0 + wall);
    if (!r.ok) {
      fail(`bot action refused (${r.reason})`);
      break;
    }
    g = r.game;
    animBefore = animationMs(r.events);
    wall += animBefore;
    for (const e of r.events) {
      if (e.kind === "attack" && firstContactMove === null) firstContactMove = g.moves - moveOffset;
      if (e.kind === "storm") stormShifted = e.shifts.length;
    }
    o.onStep?.(g, r.events);
  }
  if (g.reason === "cap" && cappedBy === null) cappedBy = "moves";
  return {
    seed,
    first,
    winner: g.winner as Army | "draw",
    reason: g.reason as EndReason,
    cappedBy,
    moves: g.moves - moveOffset,
    turns: g.turnNo,
    wallMs: wall,
    firstContactMove,
    stormTurn: g.stormAt,
    stormFired: g.stormDone,
    stormShifted,
    twoStepsSpent: twoSteps,
    lateWithoutRebase: late,
    powers,
    sealed,
  };
}

export interface BatchOptions extends Omit<MatchOptions, "first" | "onStep"> {
  seed: number;
  count: number;
}

/** Match i uses seed `seed + i`; the side that moves first alternates so neither army gets the head start more often. */
export function runBatch(o: BatchOptions): MatchRow[] {
  return Array.from({ length: o.count }, (_, i) => runMatch(o.seed + i, { ...o, first: i % 2 ? "it" : "us" }));
}

export const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export interface Summary {
  n: number;
  moves: { median: number; p90: number; max: number };
  turns: { p5: number; median: number };
  wallMin: { median: number; p90: number; max: number };
  reasons: Record<EndReason, number>;
  capByMoves: number;
  capByTime: number;
  draws: number;
  firstMoverWins: number;
  decided: number;
  armyWins: Record<Army, number>;
  firstContactTurn: { p25: number; median: number };
  stormFired: number;
  stormMoved: number;
  stormMoved2: number;
  endedBeforeStormWindowEnd: number;
  twoStepsPerMatch: number;
  lateWithoutRebase: number;
  wallOver: Record<number, number>;
  movesOver: Record<number, number>;
  maxMoves: number;
  /** Per power: uses per Match and the share of Matches that used it at least once. */
  powerUse: Record<PowerName, { perMatch: number; share: number }>;
  /** Share of Matches with a sealed Truck at any turn start (either army), by army, and among Matches ended by the cap. */
  sealedAny: number;
  sealedByArmy: Record<Army, number>;
  sealedAmongCap: number;
  capMatches: number;
}

export function aggregate(rows: MatchRow[], probe: MatchRow[] = rows): Summary {
  const n = rows.length;
  const reasons: Record<EndReason, number> = { truck: 0, stuck: 0, timeouts: 0, cap: 0 };
  for (const r of rows) reasons[r.reason]++;
  const decided = rows.filter((r) => r.winner !== "draw");
  const share = (xs: MatchRow[], f: (r: MatchRow) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
  const pn = probe.length;
  const capped = rows.filter((r) => r.reason === "cap");
  const anySealed = (r: MatchRow) => r.sealed.us || r.sealed.it;
  return {
    n,
    moves: { median: percentile(rows.map((r) => r.moves), 50), p90: percentile(rows.map((r) => r.moves), 90), max: Math.max(...rows.map((r) => r.moves)) },
    turns: { p5: percentile(probe.map((r) => r.turns), 5), median: percentile(probe.map((r) => r.turns), 50) },
    wallMin: {
      median: percentile(rows.map((r) => r.wallMs), 50) / 60000,
      p90: percentile(rows.map((r) => r.wallMs), 90) / 60000,
      max: Math.max(...rows.map((r) => r.wallMs)) / 60000,
    },
    reasons,
    capByMoves: share(rows, (r) => r.cappedBy === "moves"),
    capByTime: share(rows, (r) => r.cappedBy === "time"),
    draws: share(rows, (r) => r.winner === "draw"),
    firstMoverWins: decided.filter((r) => r.winner === r.first).length / Math.max(1, decided.length),
    decided: decided.length,
    armyWins: { us: decided.filter((r) => r.winner === "us").length / Math.max(1, decided.length), it: decided.filter((r) => r.winner === "it").length / Math.max(1, decided.length) },
    firstContactTurn: {
      p25: percentile(probe.filter((r) => r.firstContactMove !== null).map((r) => r.firstContactMove as number), 25),
      median: percentile(probe.filter((r) => r.firstContactMove !== null).map((r) => r.firstContactMove as number), 50),
    },
    stormFired: share(rows, (r) => r.stormFired),
    stormMoved: share(rows, (r) => r.stormShifted >= 1),
    stormMoved2: share(rows, (r) => r.stormShifted >= 3),
    endedBeforeStormWindowEnd: share(probe, (r) => r.turns < STORM_WINDOW.to),
    twoStepsPerMatch: rows.reduce((s, r) => s + r.twoStepsSpent, 0) / Math.max(1, n),
    lateWithoutRebase: rows.reduce((s, r) => s + r.lateWithoutRebase, 0) / Math.max(1, n),
    wallOver: Object.fromEntries([10, 15, 20, 30].map((m) => [m, pn ? probe.filter((r) => r.wallMs > m * 60000).length / pn : 0])),
    movesOver: Object.fromEntries([100, 150, 200, 250, 300, 400].map((c) => [c, pn ? probe.filter((r) => r.moves > c).length / pn : 0])),
    maxMoves: Math.max(...probe.map((r) => r.moves)),
    powerUse: Object.fromEntries(POWERS.map((p) => [p, { perMatch: rows.reduce((s, r) => s + r.powers[p], 0) / Math.max(1, n), share: share(rows, (r) => r.powers[p] > 0) }])) as Summary["powerUse"],
    sealedAny: share(rows, anySealed),
    sealedByArmy: { us: share(rows, (r) => r.sealed.us), it: share(rows, (r) => r.sealed.it) },
    sealedAmongCap: share(capped, anySealed),
    capMatches: capped.length,
  };
}

/** The runs a report compares, all over the same seeds. */
export interface Study {
  /** Version 5 rules with the plain bot on both sides: the game before powers. */
  before: MatchRow[];
  standard: MatchRow[];
  /** Same seeds as `standard`, caps lifted. */
  standardUncapped: MatchRow[];
  /** The Italian side plays the fortress policy, the US side standard. */
  fortressIt: MatchRow[];
  /** The US side plays the fortress policy, the Italian side standard. */
  fortressUs: MatchRow[];
}

export function runStudy(o: { seed: number; count: number; pace?: Pace }): Study {
  const pace = o.pace ?? DEFAULT_PACE;
  const base = { seed: o.seed, count: o.count, pace };
  return {
    before: runBatch({ ...base, version: 5, policies: { us: "plain", it: "plain" } }),
    standard: runBatch(base),
    standardUncapped: runBatch({ ...base, capMoves: 3000, capMs: 6 * 3600_000 }),
    fortressIt: runBatch({ ...base, policies: { us: "standard", it: "fortress" } }),
    fortressUs: runBatch({ ...base, policies: { us: "fortress", it: "standard" } }),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const FLAG = { cap: 5, firstMover: 55, sealed: 10 } as const;

export interface ReportInfo {
  seed: number;
  count: number;
  pace?: Pace;
}

/** Fraction of decided Matches won by the army that played `side` in a fortress run. */
const fortressWins = (rows: MatchRow[], army: Army) => {
  const decided = rows.filter((r) => r.winner !== "draw");
  return { wins: decided.filter((r) => r.winner === army).length / Math.max(1, decided.length), decided: decided.length, draws: rows.length - decided.length };
};

/** The markdown report. */
export function renderReport(study: Study, info: ReportInfo): string {
  const pace = info.pace ?? DEFAULT_PACE;
  const s = aggregate(study.standard);
  const b = aggregate(study.before);
  const p = aggregate(study.standardUncapped);
  const fit = aggregate(study.fortressIt);
  const fus = aggregate(study.fortressUs);
  const runs: { name: string; s: Summary }[] = [
    { name: "Standard vs standard", s },
    { name: "Fortress (Royal Italian Army) vs standard", s: fit },
    { name: "Fortress (US Army) vs standard", s: fus },
  ];
  const capOf = (x: Summary) => x.capByMoves + x.capByTime;
  const flags: string[] = [];
  for (const { name, s: x } of runs) {
    if (capOf(x) > FLAG.cap / 100) flags.push(`${name}: the safety cap decides ${pct(capOf(x))} of Matches (threshold ${FLAG.cap}%).`);
    if (x.firstMoverWins > FLAG.firstMover / 100) flags.push(`${name}: the side that moves first wins ${pct(x.firstMoverWins)} of decided Matches (threshold ${FLAG.firstMover}%).`);
    if (x.sealedAny > FLAG.sealed / 100) flags.push(`${name}: a sealed Truck stands at some turn start in ${pct(x.sealedAny)} of Matches (threshold ${FLAG.sealed}%).`);
  }
  const smallest = (shares: Record<number, number>) => {
    const keys = Object.keys(shares).map(Number);
    return keys.find((k) => shares[k] <= 0.03) ?? keys[keys.length - 1];
  };
  const moveCapProposal = smallest(p.movesOver);
  const timeCapProposal = smallest(p.wallOver);
  const stormTo = Math.max(STORM_WINDOW.to, Math.min(p.turns.p5, 40));
  const row = (label: string, f: (x: Summary) => string) => `| ${label} | ${f(b)} | ${f(s)} |`;
  const fortressRow = (name: string, x: Summary, rows: MatchRow[], army: Army) => {
    const fw = fortressWins(rows, army);
    return `| ${name} | ${x.n} | ${pct(x.reasons.truck / x.n)} / ${pct(x.reasons.stuck / x.n)} / ${pct(x.reasons.cap / x.n)} / ${pct(x.reasons.timeouts / x.n)} | ${pct(fw.wins)} (of ${fw.decided}) | ${pct(x.firstMoverWins)} | ${pct(x.sealedAny)} (${pct(x.sealedByArmy[army])} on the fortress side) | ${pct(x.sealedAmongCap)} of ${x.capMatches} |`;
  };
  const lines = [
    `Seed ${info.seed}, ${info.count} Matches per run, bots on the app's rules engine (RULES_VERSION 6, with powers). The first side to move alternates, so each army moves first in half of them. Pace per action: ${pace.thinkMinMs / 1000}-${pace.thinkMaxMs / 1000} s thinking, ${pace.chainMs / 1000} s chain time, plus the board's animation (slides, flip, storm). Every run uses the same seeds, so the layouts match across runs.`,
    "",
    "The **standard** bot uses the powers (Rescue when an enemy stands by its Truck, Blast when 3+ hidden enemies surround an Engineer, a Major digs in early beside its Truck or depot, the 10 becomes a Spy only to attack a shown 10). The **fortress** bot digs both Majors in around its Truck and otherwise plays like standard. **Before powers** is the version-5 rules (4-direction steps, Engineers defuse, no powers) with the plain bot on both sides, rerun on the same seeds with `version: 5` and policy `plain`, so the two columns below differ only in the rules and the bot's new options.",
    "",
    "### Standard vs standard, before and after powers",
    "",
    "For reference, the report written before powers (seed 1, 3000 Matches, the engine and bot of that day) read: 108 / 170 / 200 moves, 83.5% Truck, 11.6% no legal move, 4.9% cap, first mover 49.5%, US Army 51.6%. The \"before\" column below is a rerun on today's code with `version: 5` and the plain bot, and it does not reproduce that file exactly (the bot has changed since; the cause was not isolated), so compare the two columns to each other, not to the old file.",
    "",
    `| Measure | Before powers (v5, plain) | With powers (v6, standard) |`,
    "|---|---|---|",
    row("Moves per Match (median / p90 / max)", (x) => `${x.moves.median} / ${x.moves.p90} / ${x.moves.max}`),
    row("Wall-clock length, minutes (median / p90 / max)", (x) => `${x.wallMin.median.toFixed(1)} / ${x.wallMin.p90.toFixed(1)} / ${x.wallMin.max.toFixed(1)}`),
    row("Ended by Truck captured", (x) => pct(x.reasons.truck / x.n)),
    row("Ended by no legal move", (x) => pct(x.reasons.stuck / x.n)),
    row("Ended by safety cap (moves / time)", (x) => `${pct(x.reasons.cap / x.n)} (${pct(x.capByMoves)} / ${pct(x.capByTime)})`),
    row("Ended by timeouts", (x) => pct(x.reasons.timeouts / x.n)),
    row("Draws", (x) => pct(x.draws)),
    row("First mover wins (of decided)", (x) => `${pct(x.firstMoverWins)} (of ${x.decided})`),
    row("US Army wins / Royal Italian Army wins", (x) => `${pct(x.armyWins.us)} / ${pct(x.armyWins.it)}`),
    row("Sealed Truck at some turn start (either army)", (x) => pct(x.sealedAny)),
    row("Sealed Truck among cap endings", (x) => `${pct(x.sealedAmongCap)} of ${x.capMatches}`),
    row("Two-Step Turns spent per Match", (x) => x.twoStepsPerMatch.toFixed(2)),
    "",
    `Sample size: ${s.n} Matches per column. Half a percentage point is within the noise at this size (about 1.8 points at 95% for a 50% rate).`,
    "",
    "### How often each power is used (standard vs standard)",
    "",
    "| Power | Uses per Match | Share of Matches using it |",
    "|---|---|---|",
    ...POWERS.map((k) => `| ${POWER_LABEL[k]} | ${s.powerUse[k].perMatch.toFixed(2)} | ${pct(s.powerUse[k].share)} |`),
    "",
    "Movement powers count the move that uses them (a Sergeant run, a Captain's diagonal, a jump, a crossing); Dig in, Blast, Rescue and Become a Spy count the action. The bot's Become a Spy needs a shown enemy 10, which blind play rarely produces.",
    "",
    "### Fortress against standard",
    "",
    "| Run | Matches | Truck / no move / cap / timeouts | Fortress side wins | First mover wins | Sealed Truck (any turn start) | Sealed among cap endings |",
    "|---|---|---|---|---|---|---|",
    fortressRow("Fortress = Royal Italian Army", fit, study.fortressIt, "it"),
    fortressRow("Fortress = US Army", fus, study.fortressUs, "us"),
    "",
    `Uses per Match in the fortress runs: Dig in ${fit.powerUse.dig_in.perMatch.toFixed(2)} (Italian fortress), ${fus.powerUse.dig_in.perMatch.toFixed(2)} (US fortress), against ${s.powerUse.dig_in.perMatch.toFixed(2)} in standard vs standard.`,
    "",
    "### Without the caps",
    "",
    `The same ${info.count} standard Matches replayed with the move and time caps lifted (limit ${p.maxMoves} moves reached). Share still running past a limit:`,
    "",
    "| Moves | " + Object.keys(p.movesOver).join(" | ") + " |",
    "|---|" + Object.keys(p.movesOver).map(() => "---").join("|") + "|",
    "| Share past it | " + Object.values(p.movesOver).map(pct).join(" | ") + " |",
    "",
    "| Minutes | " + Object.keys(p.wallOver).join(" | ") + " |",
    "|---|" + Object.keys(p.wallOver).map(() => "---").join("|") + "|",
    "| Share past it | " + Object.values(p.wallOver).map(pct).join(" | ") + " |",
    "",
    `Uncapped, the median Match runs ${p.moves.median} moves (p90 ${p.moves.p90}, ${p.wallMin.median.toFixed(1)} min median, ${p.wallMin.p90.toFixed(1)} min p90).`,
    "",
    "### Dust Storm",
    "",
    `The storm turn is drawn from turns ${STORM_WINDOW.from} to ${STORM_WINDOW.to} (a turn is one side's go). It fired in ${pct(s.stormFired)} of standard Matches, moved at least one piece in ${pct(s.stormMoved)} and three or more in ${pct(s.stormMoved2)}. The median uncapped Match has ${p.turns.median} turns; 5% end before turn ${p.turns.p5}. The first attack, usually a Recon probe, comes after ${p.firstContactTurn.median} moves.`,
    "",
    "### Flags",
    "",
    `Thresholds from the spec: cap decides more than ${FLAG.cap}%, first mover wins more than ${FLAG.firstMover}%, a sealed Truck in more than ${FLAG.sealed}% of Matches. Checked on all three runs.`,
    "",
    ...(flags.length ? flags.map((f) => `- ${f}`) : ["- No threshold crossed."]),
    ...(s.lateWithoutRebase > 0.5 ? [`- With a turn clock that keeps running during animations, ${s.lateWithoutRebase.toFixed(1)} actions per Match would pass the ${TURN_MS / 1000} s turn after thinking, chain time and the opponent's animation. The practice screen rebases the clock after each animation; the on-chain clock does not.`] : []),
  ];
  if (s.sealedAny > FLAG.sealed / 100 || fit.sealedAny > FLAG.sealed / 100 || fus.sealedAny > FLAG.sealed / 100) {
    lines.push(
      "",
      "### Options if the sealed-Truck flag stands (nothing is applied)",
      "",
      "- Bring back Engineer defusing: an Engineer attacking a Landmine (original or dug-in Major) defuses it again, as in version 5. Reopens every sealed corner; costs the Engineer's new Blast being the only Engineer power that matters.",
      "- Limit Dig in next to one's own Truck: a Major may not dig in on a square touching its own Truck, or only one dug-in Major may touch it. Keeps the two original mines as the most a corner can hold.",
    );
  }
  if (capOf(s) > FLAG.cap / 100 || capOf(fit) > FLAG.cap / 100 || capOf(fus) > FLAG.cap / 100) {
    const left = (c: number) => pct(p.movesOver[c] ?? 0);
    lines.push(
      "",
      "### Options if the cap flag stands (nothing is applied)",
      "",
      `- Raise the move cap (and the time cap with it, or the clock still ends the Match first). Share of standard Matches still running past 250 / 300 / 400 moves: ${left(250)} / ${left(300)} / ${left(400)}; past 15 / 20 / 30 minutes: ${pct(p.wallOver[15])} / ${pct(p.wallOver[20])} / ${pct(p.wallOver[30])}. The rules use ${MOVE_CAP} moves and ${CAP_MS / 60000} minutes. A higher cap only moves the line; the shuffling Matches just run longer.`,
      "- Add a no-progress ending: a set number of moves in a row with no attack, depot step or action ends the Match on the cap tiebreak. It targets the bot's shuffling directly and leaves honest long Matches alone; it is a new rule and needs a counter on the Battle.",
      `- Leave the rules and read the flag as the bot's shuffling (probably, not measured): the cap decided ${pct(capOf(b))} of Matches before powers on the same seeds (see the first table), and a human is unlikely to shuffle. Decide after Practice.`,
    );
  }
  if (s.firstMoverWins > FLAG.firstMover / 100 || fit.firstMoverWins > FLAG.firstMover / 100 || fus.firstMoverWins > FLAG.firstMover / 100) {
    lines.push(
      "",
      "### Options if the first-mover flag stands (nothing is applied)",
      "",
      "- Bank one Two-Step Turn for the side that moves second.",
      "- Delay the first mover's depot raid by one turn.",
    );
  }
  lines.push(
    "",
    "### Proposal (the rules are unchanged)",
    "",
    p.movesOver[moveCapProposal] <= 0.03
      ? `- Move cap: ${moveCapProposal}, the smallest tested value that leaves at most 3% of Matches still running (the rules use ${MOVE_CAP}).`
      : `- Move cap: no tested value leaves at most 3% still running; ${moveCapProposal} still leaves ${pct(p.movesOver[moveCapProposal])} because the bot shuffles pieces without finishing (the rules use ${MOVE_CAP}).`,
    p.wallOver[timeCapProposal] <= 0.03
      ? `- Time cap: ${timeCapProposal} minutes by the same test (the rules use ${CAP_MS / 60000}).`
      : `- Time cap: no tested value leaves at most 3% still running; ${timeCapProposal} minutes still leaves ${pct(p.wallOver[timeCapProposal])} (the rules use ${CAP_MS / 60000}).`,
    `- Storm window: turns ${STORM_WINDOW.from} to ${stormTo}. 95% of Matches run past turn ${p.turns.p5}, so a later storm still lands; a wider window makes the hidden storm turn harder to guess. The placeholder is ${STORM_WINDOW.from} to ${STORM_WINDOW.to}.`,
    "",
    "### What this does not tell us",
    "",
    "The bot plays blind and simply: it never reads the opponent's hidden ranks, pushes forward, attacks with strong pieces and probes with Recons. Its use of the powers is a fixed recipe: it digs in early and rescues when an enemy touches the Truck, but it never plans a Blast, never bluffs with a switch, never deliberately hunts a sealed Truck with a Lieutenant, Sergeant or Captain, and never builds a fortress unless the fortress policy is on. A human who walls the Truck in on purpose, or who attacks a walled Truck on purpose, will see a different sealed-Truck share than the bot does, in either direction. The switch of the General of the Army is almost never used by the bot, so its balance is untested here. Human Players will be slower on some turns and more decisive on others, so these numbers bound the rules, they do not predict Match length or fairness. Human playtests come next and should replace this pace.",
  );
  return lines.join("\n");
}
