/**
 * A Practice ride, pure: the Player and 9 simulated riders on the real engine, odds, Tells, Brake and refund schedule,
 * all in the browser. Nothing here reads or sends anything: the whole ride is a function of the draw, the riders and
 * the Player's own Brake and Jump, so the same seed replays the same ride.
 */
import { MAX_CRASH_MS, MEDIAN_MS, MIN_CRASH_MS, impactMs, placeSharesBps, positionMs, refund, ride, type Ride } from "../engine";
import { RAILCAR_FEES, planPayout } from "../payout";
import type { Tells } from "../tell-state";
import type { RailcarView, ResultRow, Rider } from "../view";
import { PLACE_WORDS } from "../words";

/** What a Practice ride is played for: the one real Railcar entry. Nothing is staked. */
export const PRACTICE_ENTRY = 500n;
export const SIM_RIDERS = 9;
export const PRACTICE_ME = "practice:you";

/**
 * A simulated rider: plans a Jump at a track position, and reads the Tells as a Player must now that a later Tell is
 * not promised (decisions Q39). Each wait runs from a Tell and ends when the next one shows.
 */
export interface PracticeRider {
  id: string;
  name: string;
  /** Track ms at which they mean to Jump. */
  planMs: number;
  /** Ms they give the car after a screw (false or real, they cannot tell) to show a later Tell before they Jump, or null when the screws alone never move them. */
  screwsWaitMs: number | null;
  /** Ms after the bolt and panel that they Jump if the sparks have not shown by then, or null when they hold for the sparks. */
  boltReactMs: number | null;
  /** Ms after the sparks that they Jump, or null when they hold through them. */
  sparkReactMs: number | null;
}

export interface Practice {
  ride: Ride;
  riders: PracticeRider[];
  /** Ride ms of the Player's one Brake. */
  brakeMs: number | null;
  /** Ride ms of the Player's Jump. */
  jumpMs: number | null;
}

export function newPractice(draw: Uint8Array, riders: PracticeRider[] = simRiders(draw)): Practice {
  return { ride: ride(draw), riders, brakeMs: null, jumpMs: null };
}

const brakes = (p: Practice) => (p.brakeMs === null ? [] : [p.brakeMs]);
/** The first ride ms at which the car has travelled `track` ms. */
const realAt = (p: Practice, track: number) => impactMs(brakes(p), track);
export const practiceImpactMs = (p: Practice) => realAt(p, p.ride.crashMs);

/** The Player's Brake: one per ride, only while aboard and before Impact. */
export function practiceBrake(p: Practice, t: number): Practice {
  if (p.brakeMs !== null || p.jumpMs !== null || t >= practiceImpactMs(p)) return p;
  return { ...p, brakeMs: t };
}

/** The Player's Jump: once, and only before Impact (a Jump at or after Impact counts as aboard). */
export function practiceJump(p: Practice, t: number): Practice {
  if (p.jumpMs !== null || t >= practiceImpactMs(p)) return p;
  return { ...p, jumpMs: t };
}

function riderJumpMs(p: Practice, r: PracticeRider): number {
  const shows = (trackAt: number | null) => (trackAt === null ? Infinity : realAt(p, trackAt));
  const [panelAt, sparksAt] = [shows(p.ride.boltAtMs), shows(p.ride.sparkAtMs)];
  const onSparks = r.sparkReactMs === null ? Infinity : sparksAt + r.sparkReactMs;
  // The wait on the panel ends when the sparks show; the wait on a screw ends at the next screw, the panel or the sparks.
  const onPanel = r.boltReactMs === null ? Infinity : panelAt + r.boltReactMs;
  const screws = [...p.ride.falseScrews, p.ride.screwAtMs].map((at) => realAt(p, at));
  const onScrews = screws.map((at, i) => {
    const jump = r.screwsWaitMs === null ? Infinity : at + r.screwsWaitMs;
    return jump < Math.min(screws[i + 1] ?? Infinity, panelAt, sparksAt) ? jump : Infinity;
  });
  return Math.min(realAt(p, r.planMs), onSparks, onPanel < sparksAt ? onPanel : Infinity, ...onScrews);
}

interface Seat {
  rider: Rider;
  /** Ride ms of the Jump if it lands before Impact, else null (aboard at Impact). */
  jumpMs: number | null;
}

function seats(p: Practice): Seat[] {
  const impact = practiceImpactMs(p);
  const valid = (ms: number | null) => (ms !== null && ms < impact ? ms : null);
  return [
    { rider: { account: PRACTICE_ME, seat: 1, me: true }, jumpMs: valid(p.jumpMs) },
    ...p.riders.map((r, i) => ({ rider: { account: r.id, seat: i + 2, me: false, name: r.name }, jumpMs: valid(riderJumpMs(p, r)) })),
  ];
}

/** The public Tells at ride ms `t`, as a real car shows them: every screw heard in one count, and the later Tells this ride shows. */
export function practiceTells(p: Practice, t: number): Tells {
  const shown = (track: number | null) => track !== null && realAt(p, track) <= t;
  return {
    screws: [...p.ride.falseScrews, p.ride.screwAtMs].filter(shown).length,
    panel: shown(p.ride.boltAtMs),
    sparks: shown(p.ride.sparkAtMs),
  };
}

/** What the Railcar screen shows at ride ms `t`: the Ride, then the Result from Impact on. */
export function practiceView(p: Practice, t: number): RailcarView {
  const all = seats(p);
  const entry = PRACTICE_ENTRY;
  if (t >= practiceImpactMs(p)) return practiceResult(p, all);
  const off = (s: Seat) => s.jumpMs !== null && s.jumpMs <= t;
  const mine = all[0];
  return {
    phase: "ride",
    delayed: null,
    clockMs: t,
    tells: practiceTells(p, t),
    aboard: all.filter((s) => !off(s)).map((s) => s.rider),
    jumped: all.filter(off).map((s) => s.rider),
    stake: BigInt(all.length) * entry,
    entry,
    me: off(mine) && mine.jumpMs !== null ? { aboard: false, jumpMs: mine.jumpMs, back: refund(entry, positionMs(brakes(p), mine.jumpMs)) } : { aboard: true },
  };
}

function practiceResult(p: Practice, all: Seat[]): Extract<RailcarView, { phase: "result" }> {
  const entry = PRACTICE_ENTRY;
  const pot = BigInt(all.length) * entry;
  const wallMs = practiceImpactMs(p);
  // Jumps in the order the car took them (the Player first on a tie).
  const jumped = all.filter((s) => s.jumpMs !== null).sort((a, b) => a.jumpMs! - b.jumpMs!) as (Seat & { jumpMs: number })[];
  const jumps = jumped.map((s) => ({ account: s.rider.account, ms: s.jumpMs, me: s.rider.me }));
  if (!jumped.length) {
    const rows: ResultRow[] = all.map((s) => ({ ...s.rider, kind: "refund", gets: entry }));
    return { phase: "result", rows, fees: 0n, pot, entry, wallMs, jumps, mine: { headline: "Nobody jumped", gets: entry, won: 0n }, outcome: "refund" };
  }
  const placed = jumped.slice(-3).reverse();
  const early = jumped.slice(0, -3).reverse();
  const back = (s: Seat & { jumpMs: number }) => refund(entry, positionMs(brakes(p), s.jumpMs));
  const refunded = early.reduce((a, s) => a + back(s), 0n);
  const pay = planPayout({ entry, seated: all.length, shares: placeSharesBps(placed.length).slice(0, placed.length), refunded, ...RAILCAR_FEES });
  const rows: ResultRow[] = [
    ...placed.map((s, k) => ({ ...s.rider, kind: "place" as const, place: k + 1, jumpMs: s.jumpMs, gets: entry + pay.won[k] })),
    ...early.map((s) => ({ ...s.rider, kind: "early" as const, jumpMs: s.jumpMs, gets: back(s) })),
    ...all.filter((s) => s.jumpMs === null).map((s) => ({ ...s.rider, kind: "aboard" as const, gets: 0n })),
  ];
  const m = rows.find((r) => r.me)!;
  const headline = m.kind === "place" ? PLACE_WORDS[(m.place ?? 1) - 1] : m.kind === "early" ? "Jumped early" : "Aboard at Impact";
  return { phase: "result", rows, fees: pay.fees.reduce((a, b) => a + b, 0n), pot, entry, wallMs, jumps, mine: { headline, gets: m.gets, won: m.kind === "place" ? m.gets - entry : 0n }, outcome: "placed" };
}

// ---- Simulated riders ---------------------------------------------------------------------------------------------

const NAMES = ["Ana", "Ben", "Cy", "Dee", "Eve", "Fin", "Gus", "Hal", "Ivy", "Jo", "Kai", "Lu", "Max", "Ned", "Oli", "Pia", "Quin", "Rae", "Tam", "Uma", "Vic", "Wes", "Yui", "Zed"];

/** A 32-bit generator seeded from the draw (FNV-1a over its bytes, then mulberry32), so a seed gives the same riders. */
function riderRng(draw: Uint8Array): () => number {
  let h = 0x811c9dc5 ^ 0x52494445; // "RIDE": riders are drawn apart from the crash point
  for (const b of draw) h = Math.imul(h ^ b, 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Nerve = "early" | "steady" | "greedy";
const NERVES: Nerve[] = ["early", "early", "steady", "steady", "steady", "steady", "greedy", "greedy", "greedy"];

/**
 * 9 riders who read the car like Players do: each picks a moment from the engine's own survival curve (10 s, then an
 * even chance a second, capped at 2:00), scaled by their nerve. Most Jump soon after the sparks when the sparks come.
 * Since a ride may never show them, many give the panel its safe 8 s and a little more, then go, and some do the same
 * with the screws (20 s and a little more); the greediest hold for the sparks whatever happens. None Brakes.
 */
export function simRiders(draw: Uint8Array): PracticeRider[] {
  const rng = riderRng(draw);
  const names = shuffle(NAMES, rng).slice(0, SIM_RIDERS);
  const nerves = shuffle(NERVES, rng);
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rng());
  const maybe = (chance: number, lo: number, hi: number) => (rng() < chance ? between(lo, hi) : null);
  return names.map((name, i) => {
    const curve = Math.min(MAX_CRASH_MS, MIN_CRASH_MS + Number(MEDIAN_MS) * -Math.log2(1 - rng()));
    const nerve = nerves[i];
    const scale = nerve === "early" ? 0.25 + 0.35 * rng() : nerve === "steady" ? 0.7 + 0.4 * rng() : 1 + 0.6 * rng();
    const planMs = Math.max(4_000, Math.round(curve * scale));
    const screwsWaitMs = nerve === "early" ? maybe(0.5, 20_000, 26_000) : nerve === "steady" ? maybe(0.4, 22_000, 34_000) : null;
    const boltReactMs = nerve === "early" ? maybe(0.7, 500, 6_000) : nerve === "steady" ? maybe(0.75, 8_000, 12_500) : maybe(0.4, 10_000, 14_500);
    const sparkReactMs = nerve === "early" ? between(300, 1_500) : nerve === "steady" ? maybe(0.75, 300, 2_500) : maybe(0.5, 800, 3_300);
    return { id: `practice:${name}`, name, planMs, screwsWaitMs, boltReactMs, sparkReactMs };
  });
}
