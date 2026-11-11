// Railcar rules, mirrored from programs/railcar/src/engine.rs.
// Integer math only; tests replay programs/railcar/tests/vectors.json and fail on drift.
// Times are milliseconds; track positions are milliseconds at full speed.

export const MIN_CRASH_MS = 10_000;
export const MAX_CRASH_MS = 120_000;
export const MEDIAN_MS = 30_000n;
export const BRAKE_MS = 5_000;
export const RIDE_CAP_MS = 600_000;

export const SCREW_LEAD = [20_000, 40_000] as const;
export const BOLT_LEAD = [8_000, 15_000] as const;
export const SPARK_LEAD = [3_000, 8_000] as const;
/**
 * Later Tells are not promised (decisions Q39): a ride shows the bolt and panel on 3 rides in 4 and the sparks on 2 rides
 * in 3, each on its own (`[shows, of]`). The screws show on every ride. A Tell that does not show is never announced.
 */
export const BOLT_SHOWS = [3, 4] as const;
export const SPARK_SHOWS = [2, 3] as const;

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

function crashFrom(w: bigint): number {
  const extra = (MEDIAN_MS * negLog2Q32(w)) >> 32n;
  const total = BigInt(MIN_CRASH_MS) + extra;
  return Number(total > BigInt(MAX_CRASH_MS) ? BigInt(MAX_CRASH_MS) : total);
}

const lead = (w: bigint, [lo, hi]: readonly [number, number]) =>
  lo + Number(w % BigInt(hi - lo + 1));

/**
 * The whole ride from the VRF output. `everyTell` replays a ride from before Tells could be absent (decisions Q39): the
 * crash point, the leads and the false screws of a draw are the same either way.
 */
export function ride(draw: Uint8Array, o: { everyTell?: boolean } = {}): Ride {
  if (draw.length !== 32) throw new Error("draw must be 32 bytes");
  const [w0, w1, w2, w3] = [0, 1, 2, 3].map((i) => word(draw, i));
  const crashMs = crashFrom(w0);
  const screwLeadMs = lead(w1, SCREW_LEAD);
  const at = (l: number) => Math.max(0, crashMs - l);
  const screwAtMs = at(screwLeadMs);

  const s = { v: w1 ^ rotl(w2, 21n) ^ rotl(w3, 42n) ^ rotl(w0, 7n) };
  const count = 2 + Number(splitmix(s) % 3n);
  const candidates: number[] = [];
  for (let i = 0; i < count; i++)
    candidates.push(2_000 + Number(splitmix(s) % 16_001n));
  candidates.sort((a, b) => a - b);
  const falseScrews = candidates.filter((c) => c + 1_000 <= screwAtMs);
  // Drawn after the false screws, in this order, as the Rust engine does.
  const shows = ([n, of]: readonly [number, number]) => splitmix(s) % BigInt(of) < BigInt(n);
  const [boltShows, sparkShows] = [shows(BOLT_SHOWS), shows(SPARK_SHOWS)];
  const boltLeadMs = boltShows || o.everyTell ? lead(w2, BOLT_LEAD) : null;
  const sparkLeadMs = sparkShows || o.everyTell ? lead(w3, SPARK_LEAD) : null;

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
  for (const [s, e] of slowPeriods(brakes))
    slowed += Math.max(0, Math.min(e, t) - Math.min(s, t));
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

/** Early-jump refund in percent of the entry, by track position. */
export function refundPct(position: number): number {
  if (position < 20_000) return 80;
  if (position < 90_000)
    return 70 - 10 * Math.floor((position - 20_000) / 10_000);
  if (position < 100_000) return 5;
  return 0;
}

export const refund = (entry: bigint, position: number): bigint =>
  (entry * BigInt(refundPct(position))) / 100n;

export const refundAt = (
  entry: bigint,
  brakes: readonly number[],
  t: number,
): bigint => refund(entry, positionMs(brakes, t));

/** Place shares in basis points, last Player off first. */
export function placeSharesBps(placed: number): [number, number, number] {
  if (placed <= 0) return [0, 0, 0];
  if (placed === 1) return [10_000, 0, 0];
  if (placed === 2) return [7_000, 3_000, 0];
  return [6_000, 2_500, 1_500];
}

/** Split amount between the placed Players; the rounding remainder goes to the top share. */
export function split(
  amount: bigint,
  placed: number,
): [bigint, bigint, bigint] {
  const bps = placeSharesBps(Math.min(placed, 3));
  const out = bps.map((b) => (amount * BigInt(b)) / 10_000n) as [
    bigint,
    bigint,
    bigint,
  ];
  if (bps[0] !== 0) out[0] += amount - (out[0] + out[1] + out[2]);
  return out;
}

export const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
