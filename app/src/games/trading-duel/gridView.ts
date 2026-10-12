import { COLUMNS, COLUMN_SECS, HEAD_START_SECS, MATCH_SECS, MAX_BAND, NO_PICK, bandOf, hits, type Track } from "./grid";

/** Columns of head-start runway before column 1, and columns in the whole world (runway + grid). */
export const PAD_COLS = HEAD_START_SECS / COLUMN_SECS;
export const WORLD_COLS = MATCH_SECS / COLUMN_SECS;
/** Height of the column header strip, px. */
export const HEADER_PX = 40;
/** Bands the view shows at its default zoom: few and tall, so a small move crosses the screen. */
export const VIEW_BANDS = 6;

export interface Layout {
  cw: number;
  /** Band height, px. Zooming scales it with the column width, within what a finger can hit. */
  rh: number;
  /** Height of the band area, px: the same at every zoom, so the page layout never moves. */
  bodyH: number;
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

/** Band height at the default zoom, and the smallest a zoomed-out band gets, for a view `viewW` px wide. */
const baseRh = (w: number): number => (w < 520 ? 56 : w < 900 ? 62 : 70);
const minRh = (w: number): number => (w < 520 ? 44 : w < 900 ? 38 : 30);

/** Column and band size for a view `viewW` px wide showing `cols` columns (default: `defaultCols`). Zooming out shrinks bands too, but never below what a finger can tap on a phone. */
export function layoutFor(viewW: number, cols?: number): Layout {
  const w = Math.max(240, viewW);
  const n = clampCols(cols ?? defaultCols(w), w);
  const base = baseRh(w);
  const rh = Math.round(Math.min(base * 1.6, Math.max(minRh(w), (base * defaultCols(w)) / n)));
  return { cw: w / n, rh, bodyH: VIEW_BANDS * base, viewW: w, nowFrac: w < 520 ? 0.2 : w < 900 ? 0.22 : 0.24 };
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

/** A price as a fractional band position: band `k` spans `k..k+1`, the start price is 0. */
export const bandUnits = (price: number, anchor: number, step: number): number => Math.max(-MAX_BAND, Math.min(MAX_BAND, (price - anchor) / step));

/** World y (px, down is positive, 0 at the start price) of a position in band units. */
export const yOfUnits = (u: number, rh: number): number => -u * rh;

/** World y of a price. */
export const yOf = (price: number, anchor: number, step: number, rh: number): number => yOfUnits(bandUnits(price, anchor, step), rh);

/** Band units shown above and below the middle of the view. */
export const halfBands = (l: Layout): number => l.bodyH / 2 / l.rh;

/** Keeps a camera (the band unit at the middle of the view) inside the bands there are. */
export const clampU = (u: number): number => Math.max(-MAX_BAND, Math.min(MAX_BAND, u));

/** How far the band layer is moved down so that band unit `u` sits in the middle of the view, px. */
export const layerOffset = (u: number, l: Layout): number => l.bodyH / 2 + u * l.rh;

/**
 * The camera's follow target: the head's band position, whole bands at a time when `stepped` (reduced
 * motion). The eased camera `cur` trails it, but never so far that the head leaves the middle part of the view.
 */
export function followU(cur: number | null, head: number, dt: number, l: Layout, stepped = false): number {
  if (stepped || cur === null) return clampU(stepped ? Math.round(head) : head);
  const rate = 3 + Math.abs(head - cur) * 1.5;
  let next = cur + (head - cur) * Math.min(1, dt * rate);
  const room = Math.max(0, halfBands(l) - 1.5);
  next = Math.max(head - room, Math.min(head + room, next));
  return clampU(next);
}

/** The band range to render for a camera: what shows plus a margin, in steps of 4 so it rarely changes. */
export function bandWindow(u: number, l: Layout): { lo: number; hi: number } {
  const Q = 4;
  const half = halfBands(l);
  const lo = Math.floor((u - half) / Q) * Q - Q;
  const hi = Math.ceil((u + half) / Q) * Q + Q;
  return { lo: Math.max(-MAX_BAND, lo), hi: Math.min(MAX_BAND, hi) };
}

/** Less of a band than this (of its height) showing at the edge of the view counts as out of view. */
const SLIVER = 0.4;

/** 1 when band `k` is above the view, -1 when below, 0 when enough of it shows to tap. */
export function offscreen(k: number, u: number, l: Layout): -1 | 0 | 1 {
  const half = halfBands(l);
  if (k > u + half - SLIVER) return 1;
  if (k + 1 < u - half + SLIVER) return -1;
  return 0;
}

/** The smallest camera move that brings band `k` fully into view. */
export function revealU(k: number, u: number, l: Layout): number {
  const half = halfBands(l);
  if (k < u - half) return clampU(k + half);
  if (k + 1 > u + half) return clampU(k + 1 - half);
  return u;
}

/** Decimals to print row prices with, so neighbouring rows read differently. */
export const priceDigits = (stepUsd: number): number => (stepUsd >= 0.1 ? 2 : stepUsd >= 0.01 ? 3 : 4);
/** Band labels carry one more decimal than the step needs, the live price two more: it visibly churns. */
export const LABEL_EXTRA_DIGITS = 1;
export const LIVE_EXTRA_DIGITS = 2;

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

/**
 * The line as points in world px, kept between frames: a new reading only appends (a point closer than `MIN_GAP_PX`
 * to the last kept one is carried as the tip instead), so a frame never walks the whole series. A change of
 * layout, start or series (trimmed or replaced) rebuilds it.
 */
export class SnakeLine {
  xs: number[] = [];
  ys: number[] = [];
  /** The newest reading, kept or not. */
  tipX = 0;
  tipY = 0;
  /** Its price in USD (the start price before any reading). */
  p = 0;
  private n = 0;
  private ctx = "";
  private base = NaN;

  sync(series: { t: number; p: number }[], startsAt: number, anchorUsd: number, l: Layout, step: number): void {
    const ctx = `${startsAt}|${anchorUsd}|${l.cw}|${l.rh}|${step}`;
    if (ctx !== this.ctx || series.length < this.n || (series.length > 0 && series[0].t !== this.base)) {
      this.ctx = ctx;
      this.base = series.length ? series[0].t : NaN;
      this.n = lowerBound(series, startsAt + 1);
      this.xs = [0];
      this.ys = [yOf(anchorUsd, anchorUsd, step, l.rh)];
      this.tipX = this.xs[0];
      this.tipY = this.ys[0];
      this.p = anchorUsd;
    }
    const end = startsAt + MATCH_SECS * 1000;
    for (; this.n < series.length && series[this.n].t <= end; this.n++) {
      const s = series[this.n];
      const x = xOf((s.t - startsAt) / 1000, l.cw);
      const y = yOf(s.p, anchorUsd, step, l.rh);
      this.tipX = x;
      this.tipY = y;
      this.p = s.p;
      if (x - this.xs[this.xs.length - 1] >= MIN_GAP_PX) {
        this.xs.push(x);
        this.ys.push(y);
      }
    }
  }

  /** Index of the first kept point at or after world x. */
  from(x: number): number {
    let lo = 0;
    let hi = this.xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

export type Mark = "hit" | "miss" | "pending" | "none" | "hidden";

/**
 * One side's per-column marks: a hit as soon as the line has touched the pick, a miss once its column
 * is done, `pending` while it could still hit, `none` for a column left empty, and `hidden` for an
 * unrevealed opponent column.
 */
export function marks(track: Track, picks: number[], t: number, anchor: bigint, step: bigint, opponent = false): Mark[] {
  return Array.from({ length: COLUMNS }, (_, c) => {
    const band = picks[c];
    const done = t >= PAD_COLS * COLUMN_SECS + (c + 1) * COLUMN_SECS;
    if (band === NO_PICK || band === undefined) return opponent && !done ? "hidden" : done ? "none" : "pending";
    if (hits(track, c, band, anchor, step)) return "hit";
    return done ? "miss" : "pending";
  });
}

/** Bands (low, high) the line has crossed in column `c` so far, or null before any sample. */
export function touchedBands(track: Track, c: number, anchor: bigint, step: bigint): [number, number] | null {
  return track.seen[c] ? [bandOf(track.lo[c], anchor, step), bandOf(track.hi[c], anchor, step)] : null;
}

/** Consecutive hits ending at the latest hit column of `m` (0 when the latest pick missed). */
export function runEndingAt(m: Mark[], c: number): number {
  let n = 0;
  for (let k = c; k >= 0 && m[k] === "hit"; k--) n++;
  return n;
}

export const hitCount = (m: Mark[]): number => m.filter((x) => x === "hit").length;
