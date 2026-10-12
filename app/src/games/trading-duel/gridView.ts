import { COLUMNS, COLUMN_SECS, HEAD_START_SECS, MATCH_SECS, NO_PICK, ROWS, hits, rowOf, type Track } from "./grid";

/** Columns of head-start runway before column 1, and columns in the whole world (runway + grid). */
export const PAD_COLS = HEAD_START_SECS / COLUMN_SECS;
export const WORLD_COLS = MATCH_SECS / COLUMN_SECS;
/** Height of the column header strip, px. */
export const HEADER_PX = 40;
/** The snake never leaves the frame: it parks this far inside the top and bottom edge. */
const EDGE_PX = 6;

export interface Layout {
  cw: number;
  rh: number;
  viewW: number;
  /** Where "now" sits across the view (0..1). */
  nowFrac: number;
}

/** Fewest columns on screen when zoomed in. */
export const MIN_COLS = 3;

/** Columns on screen by default for a view `viewW` px wide: a phone shows about four, a desktop seven and a half. */
export const defaultCols = (viewW: number): number => (viewW < 520 ? 4.3 : viewW < 900 ? 6 : 7.6);

/** Most columns on screen when zoomed out: no column narrower than a finger-sized 44 px, and never more than the 12 of the grid. */
export const maxCols = (viewW: number): number => Math.min(12, Math.max(defaultCols(viewW), Math.floor(Math.max(240, viewW) / 44)));

/** Keeps a column count inside what this width allows. */
export const clampCols = (cols: number, viewW: number): number => Math.min(maxCols(viewW), Math.max(MIN_COLS, cols));

/** Column and row size for a view `viewW` px wide showing `cols` columns (default: `defaultCols`). The 8 rows never change size with the zoom. */
export function layoutFor(viewW: number, cols?: number): Layout {
  const w = Math.max(240, viewW);
  const n = clampCols(cols ?? defaultCols(w), w);
  if (w < 520) return { cw: w / n, rh: 44, viewW: w, nowFrac: 0.2 };
  if (w < 900) return { cw: w / n, rh: 48, viewW: w, nowFrac: 0.22 };
  return { cw: w / n, rh: 52, viewW: w, nowFrac: 0.24 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World x of a time in seconds since the start. */
export const xOf = (secs: number, cw: number): number => (clamp(secs, 0, MATCH_SECS) / COLUMN_SECS) * cw;

/** World x of the left edge of column `c`. */
export const columnX = (c: number, cw: number): number => (PAD_COLS + c) * cw;

/**
 * How far the world is scrolled left so that "now" sits at `nowFrac` of the view; held at 0 early and
 * at the end. `stepped` jumps a whole column at a time (reduced motion).
 */
export function cameraX(secs: number, l: Layout, stepped = false): number {
  const t = stepped ? Math.floor(clamp(secs, 0, MATCH_SECS) / COLUMN_SECS) * COLUMN_SECS : secs;
  return clamp(xOf(t, l.cw) - l.viewW * l.nowFrac, 0, Math.max(0, WORLD_COLS * l.cw - l.viewW));
}

/** The furthest the world can be scrolled. */
export const maxCamera = (l: Layout): number => Math.max(0, WORLD_COLS * l.cw - l.viewW);

/** Keeps a free (panned) camera inside the world. */
export const clampCamera = (x: number, l: Layout): number => clamp(x, 0, maxCamera(l));

/** The camera after a zoom from `from` to `to`, keeping the time under `anchorFrac` (0..1 across the view) where it was. */
export function cameraAfterZoom(cam: number, from: Layout, to: Layout, anchorFrac: number): number {
  const secs = ((cam + from.viewW * anchorFrac) / from.cw) * COLUMN_SECS;
  return clampCamera((secs / COLUMN_SECS) * to.cw - to.viewW * anchorFrac, to);
}

/** A price as a fractional row position: 4 is the start price, row `r` spans r..r+1. */
export const rowUnits = (price: number, anchor: number, step: number): number => (price - anchor) / step + 4;

/** World y (from the top of the rows) of a price, kept inside the frame. */
export const yOf = (price: number, anchor: number, step: number, rh: number): number => clamp((ROWS - rowUnits(price, anchor, step)) * rh, EDGE_PX, ROWS * rh - EDGE_PX);

/** Decimals to print row prices with, so neighbouring rows read differently. */
export const priceDigits = (stepUsd: number): number => (stepUsd >= 0.1 ? 2 : stepUsd >= 0.01 ? 3 : 4);

export interface SnakePoint {
  /** Seconds since the start. */
  t: number;
  p: number;
}

/** Index of the first item whose `ms` is not below `ms` (binary search; `series` is in time order). */
function lowerBound(series: { t: number }[], ms: number, from = 0, until = series.length): number {
  let lo = from;
  let hi = until;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Points closer than this across (px) are drawn as one; a feed at 20 Hz is denser than a screen needs. */
const MIN_GAP_PX = 1.6;

/**
 * SVG path of the line: the price at the start, then every sample from the feed that falls in the
 * game (ms in, seconds out), smoothed through the midpoints. Only the part between world x `x0` and
 * `x1` is written (plus one point each side), so a long, dense series stays cheap to draw. Returns
 * where the whole line ends (the last sample, even when it lies outside the window) and its price.
 */
export function snakeWindow(series: { t: number; p: number }[], startsAt: number, anchorUsd: number, l: Layout, step: number, x0 = 0, x1 = Infinity): { d: string; x: number; y: number; p: number } {
  const from = lowerBound(series, startsAt + 1);
  const to = lowerBound(series, startsAt + MATCH_SECS * 1000 + 1);
  const px = (ms: number) => xOf((ms - startsAt) / 1000, l.cw);
  const py = (p: number) => yOf(p, anchorUsd, step, l.rh);
  const endX = to > from ? px(series[to - 1].t) : 0;
  const endP = to > from ? series[to - 1].p : anchorUsd;
  const endY = py(endP);
  let lo = from;
  let hi = to;
  if (x0 > 0) lo = Math.max(from, lowerBound(series, startsAt + (x0 / l.cw) * COLUMN_SECS * 1000, from, to) - 1);
  if (Number.isFinite(x1)) hi = Math.min(to, lowerBound(series, startsAt + (x1 / l.cw) * COLUMN_SECS * 1000, from, to) + 1);
  const xy: [number, number][] = [];
  if (lo === from) xy.push([0, py(anchorUsd)]);
  for (let i = lo; i < hi; i++) {
    const x = px(series[i].t);
    const prev = xy[xy.length - 1];
    if (prev && x - prev[0] < MIN_GAP_PX && i < hi - 1) continue;
    xy.push([x, py(series[i].p)]);
  }
  if (!xy.length) xy.push([endX, endY]);
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(xy[0][0])} ${f(xy[0][1])}`;
  for (let i = 1; i < xy.length - 1; i++) {
    const [x, y] = xy[i];
    const [nx, ny] = xy[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const last = xy[xy.length - 1];
  if (xy.length > 1) d += `L${f(last[0])} ${f(last[1])}`;
  return { d, x: endX, y: endY, p: endP };
}

export type Mark = "hit" | "miss" | "pending" | "none" | "hidden";

/**
 * One side's per-column marks: a hit as soon as the line has touched the pick, a miss once its column
 * is done, `pending` while it could still hit, `none` for a column left empty, and `hidden` for an
 * unrevealed opponent column.
 */
export function marks(track: Track, picks: number[], t: number, anchor: bigint, step: bigint, opponent = false): Mark[] {
  return Array.from({ length: COLUMNS }, (_, c) => {
    const row = picks[c];
    const done = t >= PAD_COLS * COLUMN_SECS + (c + 1) * COLUMN_SECS;
    if (row === NO_PICK || row === undefined) return opponent && !done ? "hidden" : done ? "none" : "pending";
    if (hits(track, c, row, anchor, step)) return "hit";
    return done ? "miss" : "pending";
  });
}

/** Rows (low, high) the line has crossed in column `c` so far, or null before any sample. */
export function touchedRows(track: Track, c: number, anchor: bigint, step: bigint): [number, number] | null {
  return track.seen[c] ? [rowOf(track.lo[c], anchor, step), rowOf(track.hi[c], anchor, step)] : null;
}

/** Consecutive hits ending at the latest hit column of `m` (0 when the latest pick missed). */
export function runEndingAt(m: Mark[], c: number): number {
  let n = 0;
  for (let k = c; k >= 0 && m[k] === "hit"; k--) n++;
  return n;
}

export const hitCount = (m: Mark[]): number => m.filter((x) => x === "hit").length;
