import { CAP_MS, MOVE_CAP, STORM_WINDOW, TURN_MS, move, newGame, seeded, startTwoStep, timeout, type Army, type EndReason, type Game, type GameEvent, type Square } from "../rules";
import { botMove } from "../practice/bot";

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
    else if (e.kind === "storm") ms += 3500;
  }
  return ms;
}

export interface MatchOptions {
  first?: Army;
  pace?: Pace;
  /** Move cap and time cap to play under; the rules' own values by default. A huge value probes how long a Match runs uncapped. */
  capMoves?: number;
  capMs?: number;
  onStep?: (g: Game, events: GameEvent[]) => void;
}

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
  /** Actions whose think + chain + the opponent's animation would have passed a 5 s turn clock that is not rebased. */
  lateWithoutRebase: number;
}

const T0 = 1_000_000;
const mix = (seed: number, salt: number) => Math.imul(seed ^ salt, 0x9e3779b1) >>> 0;

/** One Match between two copies of the practice bot. Same seed, same Match: the thinking times come from their own stream. */
export function runMatch(seed: number, o: MatchOptions = {}): MatchRow {
  const pace = o.pace ?? DEFAULT_PACE;
  const capMoves = o.capMoves ?? MOVE_CAP;
  const capMs = o.capMs ?? CAP_MS;
  const first = o.first ?? (seed % 2 ? "us" : "it");
  const rng = seeded(mix(seed, 0x1234abcd));
  const time = seeded(mix(seed, 0x5eed7117));
  const base = newGame(rng, T0, first);
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
  const fail = (what: string): never => {
    throw new Error(`seed ${seed}: ${what}`);
  };

  while (!g.winner) {
    const m = botMove(g, rng);
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
      const s = startTwoStep(g, T0 + wall);
      if (!s.ok) fail(`two-step refused (${s.reason})`);
      else {
        g = s.game;
        twoSteps++;
        wall += pace.chainMs;
      }
    }
    const r = move(g, { id: m.id, to: m.to, at: T0 + wall });
    if (!r.ok) {
      fail(`bot move refused (${r.reason})`);
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
}

export function aggregate(rows: MatchRow[], _pace: Pace, probe: MatchRow[] = rows): Summary {
  const n = rows.length;
  const reasons: Record<EndReason, number> = { truck: 0, stuck: 0, timeouts: 0, cap: 0 };
  for (const r of rows) reasons[r.reason]++;
  const decided = rows.filter((r) => r.winner !== "draw");
  const share = (xs: MatchRow[], f: (r: MatchRow) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
  const pn = probe.length;
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
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export interface ReportInfo {
  seed: number;
  count: number;
  pace?: Pace;
}

/** The markdown report. `probe` is the same Matches played with the caps lifted, to see how long a Match runs on its own. */
export function renderReport(s: Summary, info: ReportInfo, probe?: Summary): string {
  const pace = info.pace ?? DEFAULT_PACE;
  const p = probe ?? s;
  const flags: string[] = [];
  const capShare = s.capByMoves + s.capByTime;
  if (capShare > 0.05) flags.push(`The safety cap decides ${pct(capShare)} of Matches (threshold 5%).`);
  if (s.firstMoverWins > 0.55) flags.push(`The side that moves first wins ${pct(s.firstMoverWins)} of decided Matches (threshold 55%).`);
  const smallest = (shares: Record<number, number>) => {
    const keys = Object.keys(shares).map(Number);
    return keys.find((k) => shares[k] <= 0.03) ?? keys[keys.length - 1];
  };
  const moveCapProposal = smallest(p.movesOver);
  const timeCapProposal = smallest(p.wallOver);
  const stormTo = Math.max(STORM_WINDOW.to, Math.min(p.turns.p5, 40));
  const lines = [
    `Seed ${info.seed}, ${info.count} Matches, two copies of the practice bot on the app's rules engine. The first side to move alternates, so each army moves first in half of them. Pace per action: ${pace.thinkMinMs / 1000}-${pace.thinkMaxMs / 1000} s thinking, ${pace.chainMs / 1000} s chain time, plus the board's animation (slides, flip, storm).`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Moves per Match (median / p90 / max) | ${s.moves.median} / ${s.moves.p90} / ${s.moves.max} |`,
    `| Wall-clock length, minutes (median / p90 / max) | ${s.wallMin.median.toFixed(1)} / ${s.wallMin.p90.toFixed(1)} / ${s.wallMin.max.toFixed(1)} |`,
    `| Ended by Truck captured | ${pct(s.reasons.truck / s.n)} |`,
    `| Ended by no legal move | ${pct(s.reasons.stuck / s.n)} |`,
    `| Ended by safety cap (moves ${pct(s.capByMoves)}, time ${pct(s.capByTime)}) | ${pct(s.reasons.cap / s.n)} |`,
    `| Ended by timeouts | ${pct(s.reasons.timeouts / s.n)} |`,
    `| Draws | ${pct(s.draws)} |`,
    `| First mover wins (of ${s.decided} decided) | ${pct(s.firstMoverWins)} |`,
    `| US Army wins / Royal Italian Army wins | ${pct(s.armyWins.us)} / ${pct(s.armyWins.it)} |`,
    `| Two-Step Turns spent per Match | ${s.twoStepsPerMatch.toFixed(2)} |`,
    "",
    "### Without the caps",
    "",
    `The same ${info.count} Matches replayed with the move and time caps lifted (limit ${p.maxMoves} moves reached). Share still running past a limit:`,
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
    `The storm turn is drawn from turns ${STORM_WINDOW.from} to ${STORM_WINDOW.to} (a turn is one side's go). It fired in ${pct(s.stormFired)} of Matches, moved at least one piece in ${pct(s.stormMoved)} and three or more in ${pct(s.stormMoved2)}. The median Match has ${p.turns.median} turns; 5% end before turn ${p.turns.p5}. The first attack, usually a Recon probe, comes after ${p.firstContactTurn.median} moves.`,
    "",
    "### Flags",
    "",
    ...(flags.length ? flags.map((f) => `- ${f}`) : ["- No threshold crossed: the cap decides at most 5% and the first mover wins at most 55%."]),
    ...(s.lateWithoutRebase > 0.5 ? [`- With a turn clock that keeps running during animations, ${s.lateWithoutRebase.toFixed(1)} actions per Match would pass the ${TURN_MS / 1000} s turn after thinking, chain time and the opponent's animation. The practice screen rebases the clock after each animation; the on-chain clock does not.`] : []),
    "",
    "### Proposal (the rules are unchanged)",
    "",
    `- Move cap: ${moveCapProposal}, the smallest tested value that leaves at most 3% of Matches still running (the rules use ${MOVE_CAP}). About 2% of Matches are still running after 400 moves because the bot shuffles pieces without finishing; a human would not.`,
    `- Time cap: ${timeCapProposal} minutes by the same test (the rules use ${CAP_MS / 60000}).`,
    `- Storm window: turns ${STORM_WINDOW.from} to ${stormTo}. 95% of Matches run past turn ${p.turns.p5}, so a later storm still lands; a wider window makes the hidden storm turn harder to guess. The placeholder is ${STORM_WINDOW.from} to ${STORM_WINDOW.to}.`,
    "",
    "### What this does not tell us",
    "",
    "The bot plays blind and simply: it never reads the opponent's hidden ranks, pushes forward, attacks with strong pieces and probes with Recons. It does not bluff, defend a Truck on purpose or plan a depot raid. Human Players will be slower on some turns and more decisive on others, so these numbers bound the rules, they do not predict Match length. Human playtests come next and should replace this pace.",
  ];
  return lines.join("\n");
}
