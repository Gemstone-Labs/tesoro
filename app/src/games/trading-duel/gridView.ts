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

/** Column and row size for a view `viewW` px wide: a phone shows about four columns, a desktop seven and a half. */
export function layoutFor(viewW: number): Layout {
  const w = Math.max(240, viewW);
  if (w < 520) return { cw: w / 4.3, rh: 44, viewW: w, nowFrac: 0.2 };
  if (w < 900) return { cw: w / 6, rh: 48, viewW: w, nowFrac: 0.22 };
  return { cw: w / 7.6, rh: 52, viewW: w, nowFrac: 0.24 };
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

/** The line to draw: the price at the start, then every sample from the feed that falls in the game (ms in, seconds out). */
export function snakePoints(series: { t: number; p: number }[], startsAt: number, anchorUsd: number): SnakePoint[] {
  const pts: SnakePoint[] = [{ t: 0, p: anchorUsd }];
  for (const s of series) {
    const t = (s.t - startsAt) / 1000;
    if (t > 0 && t <= MATCH_SECS && t > pts[pts.length - 1].t) pts.push({ t, p: s.p });
  }
  return pts;
}

/** SVG path through the points, smoothed through the midpoints, plus where it ends. */
export function snakePath(pts: SnakePoint[], l: Layout, anchor: number, step: number): { d: string; x: number; y: number } {
  const xy = pts.map((q) => [xOf(q.t, l.cw), yOf(q.p, anchor, step, l.rh)] as const);
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(xy[0][0])} ${f(xy[0][1])}`;
  for (let i = 1; i < xy.length - 1; i++) {
    const [x, y] = xy[i];
    const [nx, ny] = xy[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const last = xy[xy.length - 1];
  if (xy.length > 1) d += `L${f(last[0])} ${f(last[1])}`;
  return { d, x: last[0], y: last[1] };
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
