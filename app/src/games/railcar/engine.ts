// Railcar rules, mirrored from programs/railcar/src/engine.rs (rules round 2, decisions Q40).
// Integer math only; tests replay programs/railcar/tests/vectors.json and fail on drift.
// Times are milliseconds; track positions are milliseconds at full speed.
//
// A car records the rules it left under (`Table.rules`), so the round history replays an old car with its own odds and
// payouts: round 1 (every Tell shown, the Early-jump refund), Q39 (later Tells not promised) and round 2 (this file's
// constants). The two older sets are frozen here and held to `vectors-round1.json`, which the round 1 Rust engine wrote.

/** The rules a car left under: 1 round 1, 2 later Tells not promised (Q39), 3 rules round 2 (Q40). */
export type RulesVersion = 1 | 2 | 3;
export const RULES_ROUND1 = 1 as const;
export const RULES_Q39 = 2 as const;
export const RULES_Q40 = 3 as const;
/** What the program writes on a car today. */
export const RULES_CURRENT: RulesVersion = RULES_Q40;

export const MIN_CRASH_MS = 5_000;
export const MAX_CRASH_MS = 120_000;
/** Median of the random part: half of all rides end by `MIN_CRASH_MS + MEDIAN_MS`. */
export const MEDIAN_MS = 20_000n;
export const BRAKE_MS = 5_000;
export const RIDE_CAP_MS = 600_000;

export const SCREW_LEAD = [9_000, 18_000] as const;
export const BOLT_LEAD = [5_000, 9_000] as const;
export const SPARK_LEAD = [3_000, 5_000] as const;
/**
 * Later Tells are not promised (decisions Q39): a ride shows the bolt and panel on 3 rides in 4 and the sparks on 2 rides
 * in 3, each on its own (`[shows, of]`). The screws show on every ride. A Tell that does not show is never announced.
 */
export const BOLT_SHOWS = [3, 4] as const;
export const SPARK_SHOWS = [2, 3] as const;

type Range = readonly [number, number];

interface RuleSet {
  minCrashMs: number;
  medianMs: bigint;
  /** The random part after the safe start: an exponential (round 1) or a Weibull of shape 2 (round 2). */
  curve: "exponential" | "weibull";
  screwLead: Range;
  boltLead: Range;
  sparkLead: Range;
  /** False screws fall in `[falseFromMs, falseFromMs + falseSpanMs]`. */
  falseFromMs: number;
  falseSpanMs: number;
  /** Every Tell shows (before Q39). */
  everyTell: boolean;
  /** The Early-jump refund schedule applies (before Q40). */
  earlyRefund: boolean;
}

const ROUND1: RuleSet = {
  minCrashMs: 10_000,
  medianMs: 30_000n,
  curve: "exponential",
  screwLead: [20_000, 40_000],
  boltLead: [8_000, 15_000],
  sparkLead: [3_000, 8_000],
  falseFromMs: 2_000,
  falseSpanMs: 16_000,
  everyTell: true,
  earlyRefund: true,
};

const RULE_SETS: Record<RulesVersion, RuleSet> = {
  1: ROUND1,
  2: { ...ROUND1, everyTell: false },
  3: {
    minCrashMs: MIN_CRASH_MS,
    medianMs: MEDIAN_MS,
    curve: "weibull",
    screwLead: SCREW_LEAD,
    boltLead: BOLT_LEAD,
    sparkLead: SPARK_LEAD,
    falseFromMs: 1_000,
    falseSpanMs: 8_000,
    everyTell: false,
    earlyRefund: false,
  },
};

const MASK = (1n << 64n) - 1n;

export type Ride = {
  crashMs: number;
  screwLeadMs: number;
  /** null when this ride does not show the bolt and panel. */
  boltLeadMs: number | null;
  /** null when this ride does not show the sparks. */
  sparkLeadMs: number | null;
  screwAtMs: number;
  boltAtMs: number | null;
  sparkAtMs: number | null;
  falseScrews: number[];
};

const rotl = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & MASK;

function word(draw: Uint8Array, i: number): bigint {
  let w = 0n;
  for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(draw[i * 8 + b]);
  return w;
}

function splitmix(state: { v: bigint }): bigint {
  state.v = (state.v + 0x9e3779b97f4a7c15n) & MASK;
  let z = state.v;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}

/** -log2((w + 1) / 2^64) in Q32. */
function negLog2Q32(w: bigint): bigint {
  const v = w + 1n;
  const k = BigInt(v.toString(2).length - 1);
  let frac = 0n;
  if (v !== 1n << k) {
    let m = v << (63n - k);
    for (let i = 0; i < 32; i++) {
      m = (m * m) >> 63n;
      frac <<= 1n;
      if (m >= 1n << 64n) {
        frac |= 1n;
        m >>= 1n;
      }
    }
  }
  return (64n << 32n) - ((k << 32n) + frac);
}

/** floor(sqrt(n)) by Newton's method, as the Rust engine takes it. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Crash point in track ms: the safe part, then the median times `-log2 U` (an exponential, round 1) or its square root (a
 * Weibull of shape 2, round 2), capped.
 */
function crashFrom(w: bigint, set: RuleSet): number {
  const log = negLog2Q32(w);
  const extra = set.curve === "weibull" ? (set.medianMs * isqrt(log << 32n)) >> 32n : (set.medianMs * log) >> 32n;
  const total = BigInt(set.minCrashMs) + extra;
  return Number(total > BigInt(MAX_CRASH_MS) ? BigInt(MAX_CRASH_MS) : total);
}

const lead = (w: bigint, [lo, hi]: Range) => lo + Number(w % BigInt(hi - lo + 1));

/** The whole ride from the VRF output under `rules` (the rules the car left under; today's when not said). */
export function ride(draw: Uint8Array, o: { rules?: RulesVersion } = {}): Ride {
  if (draw.length !== 32) throw new Error("draw must be 32 bytes");
  const set = RULE_SETS[o.rules ?? RULES_CURRENT];
  const [w0, w1, w2, w3] = [0, 1, 2, 3].map((i) => word(draw, i));
  const crashMs = crashFrom(w0, set);
  const screwLeadMs = lead(w1, set.screwLead);
  const at = (l: number) => Math.max(0, crashMs - l);
  const screwAtMs = at(screwLeadMs);

  const s = { v: w1 ^ rotl(w2, 21n) ^ rotl(w3, 42n) ^ rotl(w0, 7n) };
  const count = 2 + Number(splitmix(s) % 3n);
  const candidates: number[] = [];
  for (let i = 0; i < count; i++) candidates.push(set.falseFromMs + Number(splitmix(s) % BigInt(set.falseSpanMs + 1)));
  candidates.sort((a, b) => a - b);
  const falseScrews = candidates.filter((c) => c + 1_000 <= screwAtMs);
  // Drawn after the false screws, in this order, as the Rust engine does.
  const shows = ([n, of]: Range) => splitmix(s) % BigInt(of) < BigInt(n);
  const [boltShows, sparkShows] = [shows(BOLT_SHOWS), shows(SPARK_SHOWS)];
  const boltLeadMs = boltShows || set.everyTell ? lead(w2, set.boltLead) : null;
  const sparkLeadMs = sparkShows || set.everyTell ? lead(w3, set.sparkLead) : null;

  return {
    crashMs,
    screwLeadMs,
    boltLeadMs,
    sparkLeadMs,
    screwAtMs,
    boltAtMs: boltLeadMs === null ? null : at(boltLeadMs),
    sparkAtMs: sparkLeadMs === null ? null : at(sparkLeadMs),
    falseScrews,
  };
}

/** Slow periods [start, end) in real ms from ascending Brake press times. */
function slowPeriods(brakes: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of brakes) {
    const last = out[out.length - 1];
    if (last && p < last[1]) last[1] += BRAKE_MS;
    else out.push([p, p + BRAKE_MS]);
  }
  return out;
}

/** Track position (track ms, rounded down) after t real ms. */
export function positionMs(brakes: readonly number[], t: number): number {
  let slowed = 0;
  for (const [s, e] of slowPeriods(brakes)) slowed += Math.max(0, Math.min(e, t) - Math.min(s, t));
  return Math.floor((2 * t - slowed) / 2);
}

/** First real ms at which the car has travelled crashMs track ms, capped at ten minutes. */
export function impactMs(brakes: readonly number[], crashMs: number): number {
  let remaining = 2 * crashMs;
  let cursor = 0;
  let t: number | undefined;
  for (const [s, e] of slowPeriods(brakes)) {
    const fast = 2 * (s - cursor);
    if (remaining <= fast) {
      t = cursor + Math.ceil(remaining / 2);
      break;
    }
    remaining -= fast;
    if (remaining <= e - s) {
      t = s + remaining;
      break;
    }
    remaining -= e - s;
    cursor = e;
  }
  t ??= cursor + Math.ceil(remaining / 2);
  return Math.min(t, RIDE_CAP_MS);
}

/**
 * Early-jump refund in percent of the entry, by track position. None since rules round 2 (decisions Q40): a Jump before
 * the last three pays 0 wherever it lands. Round 1 cars keep their schedule for the history's replay.
 */
export function refundPct(position: number, rules: RulesVersion = RULES_CURRENT): number {
  if (!RULE_SETS[rules].earlyRefund) return 0;
  if (position < 20_000) return 80;
  if (position < 90_000) return 70 - 10 * Math.floor((position - 20_000) / 10_000);
  if (position < 100_000) return 5;
  return 0;
}

export const refund = (entry: bigint, position: number, rules: RulesVersion = RULES_CURRENT): bigint => (entry * BigInt(refundPct(position, rules))) / 100n;

export const refundAt = (entry: bigint, brakes: readonly number[], t: number, rules: RulesVersion = RULES_CURRENT): bigint => refund(entry, positionMs(brakes, t), rules);

/** Place shares in basis points, last Player off first. */
export function placeSharesBps(placed: number): [number, number, number] {
  if (placed <= 0) return [0, 0, 0];
  if (placed === 1) return [10_000, 0, 0];
  if (placed === 2) return [7_000, 3_000, 0];
  return [6_000, 2_500, 1_500];
}

/** Split amount between the placed Players; the rounding remainder goes to the top share. */
export function split(amount: bigint, placed: number): [bigint, bigint, bigint] {
  const bps = placeSharesBps(Math.min(placed, 3));
  const out = bps.map((b) => (amount * BigInt(b)) / 10_000n) as [bigint, bigint, bigint];
  if (bps[0] !== 0) out[0] += amount - (out[0] + out[1] + out[2]);
  return out;
}

export const hexToBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
