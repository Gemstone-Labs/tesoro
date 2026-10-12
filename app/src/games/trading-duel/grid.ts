/**
 * The price grid: one definition of the rules, mirrored by `programs/trading_duel/src/engine.rs` and
 * tested against the same vectors (`programs/trading_duel/tests/fixtures/grid-vectors.json`).
 * Prices are bigint in 1e-8 USD, times are seconds since the Match started, so integer maths matches Rust.
 */

export const COLUMNS = 12;
export const COLUMN_SECS = 10;
export const HEAD_START_SECS = 30;
export const LOCK_AHEAD_SECS = 10;
export const HIT_POINTS = 100;
/** Picks are signed bands (i16 on chain); this one means "no pick". */
export const NO_PICK = -32768;
/** Bands are clamped to +-MAX_BAND so none ever equals NO_PICK. */
export const MAX_BAND = 32767;
/** Seconds from the start to the end of the last column. */
export const MATCH_SECS = HEAD_START_SECS + COLUMNS * COLUMN_SECS;

export type GridAsset = "SOL" | "ETH" | "HYPE";

/**
 * Row height as parts per million of the anchor price (the price when the Match starts).
 * Calibrated 2026-10-12 from 150 s windows (anchor = first close), scored per 10 s column:
 *  - SOL: Binance SOLUSDT 1 s closes, 6000 s over 6 windows (1 s sigma 67 ppm). At 250 ppm a
 *    column touches 1.7 rows on average (88% touch at most 2) and the line stays in the 6 inner
 *    rows 83% of the time.
 *  - ETH: Binance ETHUSDT 1 s closes, 8000 s over 8 windows (sigma 41 ppm). At 200 ppm: 1.5 rows,
 *    93% touch at most 2, 79% inner.
 *  - HYPE: no 1 s history on Binance; Hyperliquid 1 m candles over 24 h give sigma 563 ppm per
 *    minute, so about 73 ppm per second (random-walk scaling), close to SOL: 270 ppm.
 * Halved on 2026-10-12 (founder: smaller boxes, about $0.0137 on SOL) to SOL 120, ETH 100, HYPE 130:
 * the line now crosses two to three bands in a typical column.
 */
export const STEP_PPM: Record<GridAsset, bigint> = { SOL: 120n, ETH: 100n, HYPE: 130n };

const PPM = 1_000_000n;

/** Floor division, also for negative numerators (BigInt `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export const stepFor = (anchor: bigint, stepPpm: bigint): bigint => {
  const s = (anchor * stepPpm) / PPM;
  return s < 1n ? 1n : s;
};

/**
 * Band `k` is `[anchor + k*step, anchor + (k+1)*step)`: band 0 starts at the anchor, negative bands
 * lie below it. Every price is in exactly one band; the result is clamped to +-MAX_BAND.
 */
export function bandOf(price: bigint, anchor: bigint, step: bigint): number {
  const k = floorDiv(price - anchor, step);
  const m = BigInt(MAX_BAND);
  return Number(k < -m ? -m : k > m ? m : k);
}

/** Dollar edges of band `k`: `from` inclusive, `to` exclusive (1e-8 USD). */
export function bandEdges(k: number, anchor: bigint, step: bigint): { from: bigint; to: bigint } {
  return { from: anchor + BigInt(k) * step, to: anchor + BigInt(k + 1) * step };
}

/** Seconds since the start at which each column begins, ends and locks. */
export const columnStart = (c: number): number => HEAD_START_SECS + COLUMN_SECS * c;
export const columnEnd = (c: number): number => columnStart(c) + COLUMN_SECS;
export const lockAt = (c: number): number => columnStart(c) - LOCK_AHEAD_SECS;

/** Picks for a column are accepted while it is not locked. */
export const canPick = (c: number, t: number): boolean => c >= 0 && c < COLUMNS && t < lockAt(c);

/** The column a time falls in, or -1 during the head start and after the last column. */
export function columnAt(t: number): number {
  if (t < HEAD_START_SECS || t >= MATCH_SECS) return -1;
  return Math.floor((t - HEAD_START_SECS) / COLUMN_SECS);
}

/** What the line did in each column. `seen[c]` is false while the column has no data. */
export interface Track {
  lo: bigint[];
  hi: bigint[];
  seen: boolean[];
  /** The last price recorded, null before the first sample. */
  last: bigint | null;
  /** The column of that sample, -1 during the head start. */
  lastCol: number;
}

export const newTrack = (): Track => ({
  lo: Array.from({ length: COLUMNS }, () => 0n),
  hi: Array.from({ length: COLUMNS }, () => 0n),
  seen: Array.from({ length: COLUMNS }, () => false),
  last: null,
  lastCol: -1,
});

function extend(tr: Track, c: number, price: bigint) {
  if (!tr.seen[c]) {
    tr.lo[c] = tr.hi[c] = price;
    tr.seen[c] = true;
  } else {
    if (price < tr.lo[c]) tr.lo[c] = price;
    if (price > tr.hi[c]) tr.hi[c] = price;
  }
}

/**
 * Records a price sample at time `t`. A sample inside column `c` first gives every column that
 * got no sample of its own (and has a line to carry) the last price recorded before it, then
 * starts `c` from that price (the line enters the column there) and extends it. Samples during
 * the head start only set the carried price; samples at or after the end are ignored.
 * Returns a new track.
 */
export function record(track: Track, t: number, price: bigint): Track {
  const tr: Track = { lo: [...track.lo], hi: [...track.hi], seen: [...track.seen], last: track.last, lastCol: track.lastCol };
  const c = columnAt(t);
  if (t >= MATCH_SECS) return tr;
  if (c >= 0) {
    if (tr.last !== null) {
      for (let k = tr.lastCol + 1; k < c; k++) if (!tr.seen[k]) extend(tr, k, tr.last);
      if (!tr.seen[c]) extend(tr, c, tr.last);
    }
    extend(tr, c, price);
  }
  tr.last = price;
  tr.lastCol = c;
  return tr;
}

/**
 * Closes the window: every column still without a sample takes the last price recorded before it as
 * both bounds. No end price is added, so the result is the same whoever ends the Match and when. A
 * column with no line behind it at all (no sample before its window) stays without data.
 */
export function finish(track: Track): Track {
  const tr: Track = { lo: [...track.lo], hi: [...track.hi], seen: [...track.seen], last: track.last, lastCol: track.lastCol };
  if (tr.last === null) return tr;
  for (let k = tr.lastCol + 1; k < COLUMNS; k++) if (!tr.seen[k]) extend(tr, k, tr.last);
  return tr;
}

/** True when the pick `band` lies within the bands the line crossed in column `c`. */
export function hits(track: Track, c: number, band: number, anchor: bigint, step: bigint): boolean {
  if (band === NO_PICK || !track.seen[c]) return false;
  return bandOf(track.lo[c], anchor, step) <= band && band <= bandOf(track.hi[c], anchor, step);
}

export type Winner = 0 | 1 | "draw";

export interface GridResult {
  hits: [boolean[], boolean[]];
  scores: [number, number];
  winner: Winner;
}

/** Scores a finished game: `picks[seat][c]` is a band or NO_PICK. */
export function settle(track: Track, picks: [number[], number[]], anchor: bigint, step: bigint): GridResult {
  const h = picks.map((p) => Array.from({ length: COLUMNS }, (_, c) => p[c] !== NO_PICK && hits(track, c, p[c], anchor, step))) as [boolean[], boolean[]];
  const scores: [number, number] = [h[0].filter(Boolean).length * HIT_POINTS, h[1].filter(Boolean).length * HIT_POINTS];
  return { hits: h, scores, winner: scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : "draw" };
}

// ---- view helpers ----

export type ColumnState = "open" | "locked" | "live" | "done";

export function columnState(c: number, t: number): ColumnState {
  if (t >= columnEnd(c)) return "done";
  if (t >= columnStart(c)) return "live";
  return t >= lockAt(c) ? "locked" : "open";
}

/** Seconds until the next column locks, and which one; null once every column is locked. */
export function nextLock(t: number): { column: number; inSecs: number } | null {
  for (let c = 0; c < COLUMNS; c++) if (t < lockAt(c)) return { column: c, inSecs: lockAt(c) - t };
  return null;
}

/** Seconds until the line enters column 1, during the head start; 0 afterwards. */
export const headStartLeft = (t: number): number => Math.max(0, HEAD_START_SECS - t);

/** Per column: true hit, false miss, null when it is not done yet or nothing was picked. */
export function columnResults(track: Track, picks: number[], t: number, anchor: bigint, step: bigint): (boolean | null)[] {
  return Array.from({ length: COLUMNS }, (_, c) => (t < columnEnd(c) || picks[c] === NO_PICK ? null : hits(track, c, picks[c], anchor, step)));
}

/** Running count of hits in a row ending at each column (0 after a miss; unpicked columns break it). */
export function streaks(results: (boolean | null)[]): number[] {
  let run = 0;
  return results.map((r) => (run = r ? run + 1 : 0));
}

/** The picks the other side may see: only locked columns, the rest read NO_PICK. */
export const revealed = (picks: number[], t: number): number[] => picks.map((p, c) => (t >= lockAt(c) ? p : NO_PICK));

export const totalScore = (results: (boolean | null)[]): number => results.filter(Boolean).length * HIT_POINTS;
