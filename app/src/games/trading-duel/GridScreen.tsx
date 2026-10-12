"use client";

import Image from "next/image";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Button, CheckIcon, GemaMark, LockIcon, XIcon } from "@/components/ui";
import { Arena, Callout, Countdown, FullScreenToggle, MuteToggle, burst, burstAt, sfx, useReducedMotion, type CalloutTone } from "../fx";
import {
  COLUMNS,
  COLUMN_SECS,
  HEAD_START_SECS,
  HIT_POINTS,
  LOCK_AHEAD_SECS,
  MATCH_SECS,
  MAX_BAND,
  NO_PICK,
  bandEdges,
  canPick,
  columnEnd,
  columnState,
  headStartLeft,
  lockAt,
  nextLock,
  type ColumnState,
  type GridAsset,
  type Track,
} from "./grid";
import type { LiveSeries } from "./feed";
import {
  HEADER_PX,
  PAD_COLS,
  WORLD_COLS,
  bandUnits,
  bandWindow,
  cameraAfterZoom,
  cameraX,
  clampCamera,
  clampCols,
  clampU,
  columnX,
  followU,
  hitCount,
  layerOffset,
  layoutFor,
  marks,
  maxCols,
  MIN_COLS,
  offscreen,
  priceDigits,
  revealU,
  runEndingAt,
  SnakeLine,
  touchedBands,
  xOf,
  yOf,
  yOfUnits,
  type Layout,
  type Mark,
} from "./gridView";
import { LiveButton, type LiveDir, type LiveState } from "./LiveButton";
import "./grid.css";

export interface GridSide {
  name: string;
  /** Avatar image URL (an animal head from `art.avatars`). */
  avatar?: string;
}

export interface GridPoint {
  /** ms (receive time) */
  t: number;
  /** USD */
  p: number;
}

export interface GridScreenProps {
  asset: GridAsset;
  /** Start price and band height in 1e-8 USD: what `grid.ts` calls `anchor` and `step`. */
  anchor: bigint;
  step: bigint;
  /** When the head start begins, ms. The clock runs from here. */
  startsAt: number;
  /** What the line did in each column (`record` / `finish` in grid.ts). */
  track: Track;
  /** Recent prices for the snake; samples before `startsAt` are ignored. A live series is read every frame and may grow without the screen re-rendering. */
  series: GridPoint[] | LiveSeries;
  /** The price feed has gone quiet. */
  stale?: boolean;
  /** Your band for each of the 12 columns, `NO_PICK` where you have none. */
  mine: number[];
  /** The opponent's band per column: `NO_PICK` until the column locks and their pick is revealed. */
  theirs: number[];
  me?: GridSide;
  opponent: GridSide;
  /** Points when the game is settled (this decides the end screen). Without it the scores follow the line. */
  final?: { you: number; them: number } | null;
  practice?: boolean;
  /** Gema entry and Pot of a real Match. */
  entry?: number;
  pot?: number;
  title?: string;
  error?: string | null;
  /** Pick a box; `band` is `NO_PICK` when you tap your own pick again to clear it. */
  onPick: (column: number, band: number) => void;
  onPlayAgain?: () => void;
  /** Where the end screen's second button goes. */
  exitHref?: string;
  exitLabel?: string;
  /** Extra line under the header (a connection note). */
  banner?: ReactNode;
  /** Freeze the clock at this time in ms (stories and screenshots). */
  nowMs?: number;
  /** How far the clock that `startsAt` is on runs ahead of this browser's, ms (a Match runs on the rollup's clock). */
  clockOffsetMs?: number;
  /** The Match is over in the game but the Pot has not been paid out yet. */
  payingOut?: boolean;
}

type Dir = "up" | "down" | "flat";

/** Seconds of no touch before a panned view swings back to the line. */
const IDLE_RETURN_MS = 8000;
/** How far a finger or mouse moves before a press becomes a drag (px). */
const DRAG_PX = 8;
const ZOOM_STEP = 1.3;

/** Which way the price last moved, ignoring readings that did not change it. */
function directionOf(points: { p: number }[], last: number): Dir {
  for (let i = points.length - 2; i >= 0 && i > points.length - 400; i--) if (points[i].p !== last) return last > points[i].p ? "up" : "down";
  return "flat";
}

type Floater = { id: number; c: number; k: number; who: "me" | "foe" };
/** A pick whose band is out of view: which column, whose, which way, which band. */
type EdgePick = { c: number; who: "me" | "foe"; dir: 1 | -1; k: number };
/** Where the player has scrolled to while panned away from the line: a camera x (px) and the band unit in the middle of the view. */
type Free = { x: number; u: number };
type Moment = { id: number; text: string; tone: CalloutTone };

/** The line on its canvas: a soft wide stroke, a bright blue one, a thin white core, all fading toward the tail. Only what shows is walked. */
function drawLine(canvas: HTMLCanvasElement | null, line: SnakeLine, hx: number, hy: number, cam: number, off: number, l: Layout) {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const k = canvas.width / l.viewW;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, l.viewW, l.bodyH);
  const { xs, ys } = line;
  const i0 = Math.max(0, line.from(cam - 40) - 1);
  const i1 = Math.min(xs.length - 1, line.from(cam + l.viewW + 40));
  if (i1 < i0) return;
  const path = new Path2D();
  const X = (i: number) => xs[i] - cam;
  const Y = (i: number) => ys[i] + off;
  path.moveTo(X(i0), Y(i0));
  for (let i = i0 + 1; i < i1; i++) path.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
  const tipOn = i1 === xs.length - 1;
  if (i1 > i0) path.lineTo(X(i1), Y(i1));
  if (tipOn && line.tipX > xs[i1]) path.lineTo(line.tipX - cam, line.tipY + off);
  if (hx > line.tipX + 0.5) path.lineTo(hx - cam, hy + off);
  const x1 = hx - cam;
  const x0 = Math.max(0, x1 - l.cw * 3.2);
  const fade = (rgb: string, a: number) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, `rgba(${rgb},${0.08 * a})`);
    g.addColorStop(0.7, `rgba(${rgb},${0.7 * a})`);
    g.addColorStop(1, `rgba(${rgb},${a})`);
    return g;
  };
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 13;
  ctx.strokeStyle = fade("159,196,255", 0.2);
  ctx.stroke(path);
  ctx.lineWidth = 7;
  ctx.strokeStyle = fade("159,196,255", 0.4);
  ctx.stroke(path);
  ctx.lineWidth = 3;
  ctx.strokeStyle = fade("234,241,251", 1);
  ctx.stroke(path);
}

/** The browser time now, read when a box is tapped. */
const wallNow = () => Date.now();
const usdOf = (v: bigint) => Number(v) / 1e8;
const fmtClock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const BURST_ME = ["#eaf1fb", "#9fc4ff", "#ffffff", "#c9dcf6"];
const BURST_FOE = ["#b99bff", "#e1d4ff", "#8d6bf0"];
const ordinalRun = (n: number) => (n >= 4 ? `On fire · ${n} in a row` : n === 3 ? "3 in a row!" : "2 in a row");

/** The browser time, refreshed just after each whole second of the game (`startsAt` is a browser time), which is when the screen's text and column states change. */
function useClock(frozen: number | undefined, startsAt: number): number {
  const [now, setNow] = useState(() => frozen ?? Date.now());
  useEffect(() => {
    if (frozen !== undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      setNow(Date.now());
      const into = (((Date.now() - startsAt) % 1000) + 1000) % 1000;
      timer = setTimeout(next, 1000 - into + 20);
    };
    next();
    return () => clearTimeout(timer);
  }, [frozen, startsAt]);
  return frozen ?? now;
}

/**
 * The Trading Duel play screen: 12 columns of time by price bands that follow a glowing line (the snake) up and down.
 * It takes plain game state and reports picks through `onPick`; practice and real Matches both feed it.
 * You are the steel diamond, the opponent the violet outline; a hit lights the box, a miss dims it.
 */
export function GridScreen(p: GridScreenProps) {
  const { asset, anchor, step, track, mine, theirs, onPick } = p;
  const offsetMs = p.clockOffsetMs ?? 0;
  // Everything below runs on this browser's clock: the game's start, seen from here.
  const startsAt = p.startsAt - offsetMs;
  const reduced = useReducedMotion();
  const now = useClock(p.nowMs, startsAt);
  const t = (now - startsAt) / 1000;
  const anchorUsd = usdOf(anchor);
  const stepUsd = usdOf(step);
  const digits = priceDigits(stepUsd);
  const money = useCallback((v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`, [digits]);
  const me = p.me ?? { name: "You" };

  const viewRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(960);
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const read = () => setViewW(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Columns on screen: null is the default for this width; the zoom buttons, pinch and ctrl+wheel set it.
  const [cols, setCols] = useState<number | null>(null);
  const layout = useMemo(() => layoutFor(viewW, cols ?? undefined), [viewW, cols]);
  const { cw, rh } = layout;
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(viewW * dpr);
    c.height = Math.round(layout.bodyH * dpr);
  }, [viewW, layout.bodyH]);
  const source = useMemo<LiveSeries>(() => (Array.isArray(p.series) ? { points: p.series, rev: 0 } : p.series), [p.series]);

  const myMarks = useMemo(() => marks(track, mine, t, anchor, step), [track, mine, t, anchor, step]);
  const foeMarks = useMemo(() => marks(track, theirs, t, anchor, step, true), [track, theirs, t, anchor, step]);
  const score = p.final ?? { you: hitCount(myMarks) * HIT_POINTS, them: hitCount(foeMarks) * HIT_POINTS };
  const over = t >= MATCH_SECS;
  const settled = !!p.final;

  // The official line: what the game recorded in each column, as a band from its lowest to its highest price.
  const bands = useMemo(
    () =>
      Array.from({ length: COLUMNS }, (_, c) => {
        if (!track.seen[c]) return null;
        const top = yOf(usdOf(track.hi[c]), anchorUsd, stepUsd, rh);
        const bottom = yOf(usdOf(track.lo[c]), anchorUsd, stepUsd, rh);
        return { x: columnX(c, cw) + 1, y: top, w: cw - 2, h: Math.max(4, bottom - top) };
      }),
    [track, anchorUsd, stepUsd, rh, cw],
  );

  // ---- the moving parts are written straight to the DOM every frame (no React render per frame) ----
  const worldRef = useRef<HTMLDivElement>(null);
  const vlRef = useRef<HTMLDivElement>(null);
  const gvlRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const chipTextRef = useRef<HTMLSpanElement>(null);
  const chipArrowRef = useRef<HTMLElement>(null);
  const ptrTextRef = useRef<HTMLSpanElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const wakeRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useRef({
    layout,
    source,
    startsAt,
    stepped: reduced,
    anchorUsd,
    stepUsd,
    money,
    mine,
    theirs,
    /** The head's band position, eased; null before the first frame. */
    hu: null as number | null,
    /** The following camera's band position (the band unit in the middle of the view), eased. */
    cf: null as number | null,
    last: 0,
    cam: 0,
    cu: 0,
    built: "",
    line: new SnakeLine(),
    eu: 0,
    near: "",
    ls: { x: 0, y: 0, dir: "in", price: "" } as LiveState,
    liveTo: null as ((s: LiveState) => void) | null,
    low: false,
    wake: "",
    dir: "flat" as Dir,
    text: "",
    textAt: 0,
    price: NaN,
    next: "flat" as Dir,
    win: "",
    edges: "",
    redraw: () => {},
  });
  // Where the player has scrolled to: `free` is a camera while panned away from the line, null while it follows.
  const view = useRef({ free: null as Free | null, returning: false, touched: 0, down: 0 });
  const [panned, setPanned] = useState(false);
  // The bands in the DOM: what shows plus a margin, moved as the camera moves. Picks out of view are edge markers.
  const [win, setWin] = useState(() => bandWindow(0, layout));
  const [edges, setEdges] = useState<EdgePick[]>([]);
  useEffect(() => {
    Object.assign(live.current, { layout, source, startsAt, stepped: reduced, anchorUsd, stepUsd, money, mine, theirs });
  });
  useEffect(() => {
    live.current.built = "";
    live.current.win = "";
    live.current.price = NaN;
  }, [layout, source, startsAt, anchorUsd, stepUsd]);
  const frozen = p.nowMs !== undefined;
  useEffect(() => {
    const apply = (ms: number, snapHead: boolean) => {
      const L = live.current;
      const V = view.current;
      const l = L.layout;
      const secs = (ms - L.startsAt) / 1000;
      const dt = Math.min(0.1, Math.max(0.001, (ms - L.last) / 1000 || 0.016));
      L.last = ms;

      // The line takes the new readings when they arrive; the tail to the head is drawn every frame.
      const followX = cameraX(secs, l, L.stepped);
      if (L.built !== String(L.source.rev)) {
        L.built = String(L.source.rev);
        L.line.sync(L.source.points, L.startsAt, L.anchorUsd, l, L.stepUsd);
        L.eu = bandUnits(L.line.p, L.anchorUsd, L.stepUsd);
        L.next = directionOf(L.source.points, L.line.p);
      }
      // The price in the chips is rewritten at most every 150 ms: it changes with every reading and is unreadable at that rate.
      if ((L.next !== L.dir || L.line.p !== L.price) && (snapHead || ms - L.textAt > 150)) {
        const dir = L.next;
        const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "◆";
        const text = L.money(L.line.p);
        L.textAt = ms;
        L.price = L.line.p;
        if (dir !== L.dir || text !== L.text) {
          L.dir = dir;
          L.text = text;
          if (chipTextRef.current) chipTextRef.current.textContent = text;
          if (chipArrowRef.current) chipArrowRef.current.textContent = arrow;
          if (ptrTextRef.current) ptrTextRef.current.textContent = dir === "flat" ? text : `${text} ${arrow}`;
          for (const el of [dotRef.current, chipRef.current, ptrTextRef.current]) el?.setAttribute("data-dir", dir);
        }
      }
      const hu = L.hu === null || snapHead ? L.eu : L.hu + (L.eu - L.hu) * Math.min(1, dt * 14);
      L.hu = hu;
      const follow = followU(snapHead ? null : L.cf, hu, dt, l, L.stepped);
      L.cf = follow;

      if (V.free && (V.returning || (V.down === 0 && !frozen && Date.now() - V.touched > IDLE_RETURN_MS))) {
        V.returning = true;
        if (L.stepped || snapHead) V.free = { x: followX, u: follow };
        else {
          const k = Math.min(1, dt * 9);
          V.free = { x: V.free.x + (followX - V.free.x) * k, u: V.free.u + (follow - V.free.u) * k };
        }
        if (Math.abs(followX - V.free.x) < 1.5 && Math.abs(follow - V.free.u) < 0.02) {
          V.free = null;
          V.returning = false;
          setPanned(false);
        }
      }
      const cam = V.free ? clampCamera(V.free.x, l) : followX;
      const cu = V.free ? clampU(V.free.u) : follow;
      L.cam = cam;
      L.cu = cu;
      const off = layerOffset(cu, l);
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${-cam}px,0,0)`;
      const vy = `translate3d(0,${off}px,0)`;
      if (vlRef.current) vlRef.current.style.transform = vy;
      if (gvlRef.current) gvlRef.current.style.transform = vy;
      if (padRef.current) padRef.current.style.backgroundPositionY = `${off}px`;

      const w = bandWindow(cu, l);
      const wk = `${w.lo}|${w.hi}`;
      if (L.win !== wk) {
        L.win = wk;
        setWin(w);
      }
      // Picks out of the view become markers on its edge. Only the ones whose column is not over.
      const out: EdgePick[] = [];
      for (let c = 0; c < COLUMNS; c++) {
        if (secs >= columnEnd(c)) continue;
        for (const who of ["me", "foe"] as const) {
          const k = (who === "me" ? L.mine : L.theirs)[c];
          if (k === undefined || k === NO_PICK) continue;
          const o = offscreen(k, cu, l);
          if (o) out.push({ c, who, dir: o, k });
        }
      }
      const ek = out.map((e) => `${e.c}${e.who}${e.dir}${e.k}`).join();
      if (L.edges !== ek) {
        L.edges = ek;
        setEdges(out);
      }

      const hy = yOfUnits(hu, l.rh);
      const hx = xOf(secs, l.cw);
      drawLine(canvasRef.current, L.line, hx, hy, cam, off, l);
      if (L.liveTo) {
        const px = hx - cam;
        const py = hy + off;
        const dx = px < 0 ? -px : px > l.viewW ? px - l.viewW : 0;
        const dy = py < 0 ? -py : py > l.bodyH ? py - l.bodyH : 0;
        const dir: LiveDir = !dx && !dy ? "in" : dx >= dy ? (px < 0 ? "left" : "right") : py < 0 ? "up" : "down";
        L.ls.x = px;
        L.ls.y = py;
        L.ls.dir = dir;
        L.ls.price = L.text;
        L.liveTo(L.ls);
      }
      const screenY = off + hy;
      if (headRef.current) {
        headRef.current.style.transform = `translate3d(${hx}px,${hy}px,0)`;
        const low = screenY < 46;
        if (low !== L.low) {
          L.low = low;
          headRef.current.classList.toggle("low", low);
        }
      }
      // the price labels the head sits on fade out; only the ones within reach of it
      const near = `${Math.ceil((-hy - 15) / l.rh)}|${Math.floor((-hy + 15) / l.rh)}`;
      if (near !== L.near) {
        L.near = near;
        const lo = Math.ceil((-hy - 15) / l.rh);
        const hi = Math.floor((-hy + 15) / l.rh);
        gvlRef.current?.querySelectorAll(".near").forEach((el) => el.classList.remove("near"));
        for (let e = lo; e <= hi; e++) gvlRef.current?.querySelector(`[data-e="${e}"]`)?.classList.add("near");
      }
      if (nowRef.current) nowRef.current.style.transform = `translate3d(${hx}px,0,0)`;
      if (ptrRef.current) ptrRef.current.style.transform = `translate3d(0,${Math.max(9, Math.min(l.bodyH - 9, screenY))}px,0)`;
      if (wakeRef.current) {
        const c = Math.floor((secs - HEAD_START_SECS) / COLUMN_SECS);
        const x0 = secs < HEAD_START_SECS ? 0 : columnX(Math.min(COLUMNS - 1, Math.max(0, c)), l.cw);
        wakeRef.current.style.transform = `translate3d(${x0}px,0,0) scaleX(${Math.max(0, hx - x0).toFixed(1)})`;
        const o = secs >= MATCH_SECS ? "0" : "1";
        if (o !== L.wake) {
          L.wake = o;
          wakeRef.current.style.opacity = o;
        }
      }
    };
    if (frozen) {
      apply(p.nowMs!, true);
      live.current.redraw = () => apply(p.nowMs!, true);
      return;
    }
    if (reduced) {
      apply(Date.now(), true);
      live.current.redraw = () => apply(Date.now(), true);
      const i = setInterval(() => apply(Date.now(), true), 1000);
      return () => clearInterval(i);
    }
    let raf = 0;
    const loop = () => {
      apply(Date.now(), false);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [frozen, p.nowMs, reduced, layout, source]);

  // ---- zoom and pan ----
  const zoomTo = (next: number, frac = 0.5) => {
    const L = live.current;
    const V = view.current;
    V.touched = Date.now();
    const cur = L.layout.viewW / L.layout.cw;
    const to = clampCols(next, L.layout.viewW);
    if (Math.abs(to - cur) < 0.005) return;
    const nl = layoutFor(L.layout.viewW, to);
    if (V.free) V.free = { x: cameraAfterZoom(V.free.x, L.layout, nl, frac), u: V.free.u };
    L.layout = nl;
    L.built = "";
    setCols(to);
  };
  const zoomBy = (factor: number, frac = 0.5) => zoomTo((live.current.layout.viewW / live.current.layout.cw) / factor, frac);
  /** Looks elsewhere: any pan stops following the line on both axes. Leave one of them out to keep where it is. */
  const panTo = (x?: number, u?: number) => {
    const L = live.current;
    const V = view.current;
    V.touched = Date.now();
    V.returning = false;
    const base = V.free ?? { x: L.cam, u: L.cu };
    V.free = { x: clampCamera(x ?? base.x, L.layout), u: clampU(u ?? base.u) };
    setPanned(true);
    L.redraw();
  };
  const goLive = () => {
    const V = view.current;
    V.touched = Date.now();
    V.returning = true;
    if (reduced || frozen) {
      V.free = null;
      V.returning = false;
      setPanned(false);
      live.current.redraw();
    }
  };
  const bindLive = useCallback((f: ((s: LiveState) => void) | null) => {
    live.current.liveTo = f;
    live.current.redraw();
  }, []);
  const atMin = cw * MIN_COLS >= viewW - 0.5;
  const atMax = viewW / cw >= maxCols(viewW) - 0.05;

  // Handlers read through a ref so the wheel listener, which is native (it has to cancel the page zoom and scroll), never goes stale.
  const gesture = useRef({ zoomBy, panTo });
  useEffect(() => {
    gesture.current = { zoomBy, panTo };
  });
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : 1;
      const L = live.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        gesture.current.zoomBy(Math.exp((-e.deltaY * unit) / (e.ctrlKey && !e.metaKey ? 100 : 300)), (e.clientX - r.left) / r.width);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        gesture.current.panTo((view.current.free?.x ?? L.cam) + (e.deltaX || e.deltaY) * unit);
      } else {
        // the wheel scrolls up and down the bands: wheel down looks at lower prices
        e.preventDefault();
        gesture.current.panTo(undefined, (view.current.free?.u ?? L.cu) - (e.deltaY * unit) / L.layout.rh);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Dragging scrolls both ways; a tap picks. A drag only starts after a few pixels, so a tap still reaches the box.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef({ x: 0, y: 0, cam: 0, cu: 0, on: false, pinch: 0, cols: 0, moved: false });
  const grab = (D: typeof drag.current, x: number, y: number) => {
    const V = view.current;
    Object.assign(D, { x, y, cam: V.free?.x ?? live.current.cam, cu: V.free?.u ?? live.current.cu });
  };
  const onViewDown = (e: PointerEvent<HTMLDivElement>) => {
    const pts_ = touches.current;
    pts_.set(e.pointerId, { x: e.clientX, y: e.clientY });
    view.current.down = pts_.size;
    view.current.touched = Date.now();
    const D = drag.current;
    D.moved = false;
    if (pts_.size === 1) Object.assign(D, { x: e.clientX, y: e.clientY, cam: live.current.cam, cu: live.current.cu, on: false, pinch: 0 });
    else if (pts_.size === 2) {
      const [a, b] = [...pts_.values()];
      Object.assign(D, { pinch: Math.hypot(a.x - b.x, a.y - b.y) || 1, cols: live.current.layout.viewW / live.current.layout.cw, on: true, moved: true });
    }
  };
  const onViewMove = (e: PointerEvent<HTMLDivElement>) => {
    const pts_ = touches.current;
    if (!pts_.has(e.pointerId)) return;
    pts_.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const D = drag.current;
    if (pts_.size >= 2 && D.pinch) {
      const [a, b] = [...pts_.values()];
      const r = e.currentTarget.getBoundingClientRect();
      zoomTo(D.cols / (Math.hypot(a.x - b.x, a.y - b.y) / D.pinch), ((a.x + b.x) / 2 - r.left) / r.width);
      return;
    }
    if (!D.on && Math.hypot(e.clientX - D.x, e.clientY - D.y) > DRAG_PX) {
      D.on = true;
      D.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      grab(D, e.clientX, e.clientY);
      return;
    }
    // dragging down moves the content down, so the camera looks at higher bands
    if (D.on && pts_.size === 1) panTo(D.cam - (e.clientX - D.x), D.cu + (e.clientY - D.y) / live.current.layout.rh);
  };
  const onViewUp = (e: PointerEvent<HTMLDivElement>) => {
    touches.current.delete(e.pointerId);
    view.current.down = touches.current.size;
    view.current.touched = Date.now();
    if (!touches.current.size) {
      drag.current.on = false;
      drag.current.pinch = 0;
      if (drag.current.moved) setTimeout(() => (drag.current.moved = false), 60);
    } else if (touches.current.size === 1) {
      // one finger left after a pinch: carry on dragging from where it is
      const [a] = [...touches.current.values()];
      grab(drag.current, a.x, a.y);
      Object.assign(drag.current, { pinch: 0, on: true });
    }
  };
  const onStageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
    else return;
    e.preventDefault();
  };

  // ---- picking ----
  const [fc, setFc] = useState<{ c: number; k: number } | null>(null);
  const focusNext = useRef<{ c: number; k: number } | null>(null);
  // The arrow keys only visit columns you can still pick that are on screen.
  const visibleCol = (c: number, camX: number) => columnX(c, cw) + cw / 2 > camX && columnX(c, cw) + cw / 2 < camX + viewW;
  const followCam = cameraX(t, layout, reduced);
  const firstOpen = Math.max(0, Math.min(COLUMNS - 1, Array.from({ length: COLUMNS }, (_, c) => c).find((c) => canPick(c, t) && visibleCol(c, followCam)) ?? nextLock(t)?.column ?? COLUMNS - 1));
  const lastPrice = source.points.length ? source.points[source.points.length - 1].p : anchorUsd;
  const headBand = Math.floor(bandUnits(lastPrice, anchorUsd, stepUsd));
  const tab = fc ?? { c: firstOpen, k: mine[firstOpen] !== NO_PICK ? mine[firstOpen] : headBand };
  const pick = (c: number, k: number) => {
    if (!canPick(c, (wallNow() - startsAt) / 1000) || settled) return;
    sfx("chip");
    onPick(c, mine[c] === k ? NO_PICK : k);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, c: number, k: number) => {
    const move: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    let nc = c;
    if (m[0]) {
      const camX = view.current.free?.x ?? live.current.cam;
      const reachable = (n: number) => canPick(n, (wallNow() - startsAt) / 1000) && visibleCol(n, camX);
      nc = c + m[0];
      while (nc >= 0 && nc < COLUMNS && !reachable(nc)) nc += m[0];
      if (nc < 0 || nc >= COLUMNS) return;
    }
    const nk = Math.max(-MAX_BAND, Math.min(MAX_BAND, k + m[1]));
    const L = live.current;
    const cu = view.current.free?.u ?? L.cu;
    const need = revealU(nk, cu, L.layout);
    if (need !== cu) panTo(undefined, need);
    focusNext.current = { c: nc, k: nk };
    setFc({ c: nc, k: nk });
  };
  // Focus follows the arrow keys once the box is in the DOM (it may have to scroll into the rendered bands first).
  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    const el = worldRef.current?.querySelector<HTMLElement>(`[data-cell="${f.c}_${f.k}"]`);
    if (!el) return;
    focusNext.current = null;
    el.focus({ preventScroll: true });
  });
  const cellHandlers = useRef({ pick, onKey });
  useEffect(() => {
    cellHandlers.current = { pick, onKey };
  });
  const cell = useMemo<CellHandlers>(
    () => ({ pick: (c, k) => cellHandlers.current.pick(c, k), key: (e, c, k) => cellHandlers.current.onKey(e, c, k), focus: (c, k) => setFc({ c, k }) }),
    [],
  );
  const showPick = (k: number) => panTo(undefined, k + 0.5);

  // ---- moments: hits, reveals, locks, streaks, the last column ----
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [announce, setAnnounce] = useState("");
  const [count, setCount] = useState<"off" | "on" | "done">("off");
  const nid = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const open = timers.current;
    return () => open.forEach(clearTimeout);
  }, []);
  const prev = useRef<{ me: Mark[]; foe: Mark[]; revealed: number; locked: number; sec: number } | null>(null);
  const sec = Math.floor(t);
  const revealedN = theirs.filter((r) => r !== NO_PICK).length;
  const lockedN = Array.from({ length: COLUMNS }, (_, c) => (t >= lockAt(c) ? 1 : 0)).reduce<number>((a, b) => a + b, 0);
  const stateKey = `${myMarks.join()}|${foeMarks.join()}|${revealedN}|${lockedN}|${sec}`;
  useEffect(() => {
    const before = prev.current;
    prev.current = { me: myMarks, foe: foeMarks, revealed: revealedN, locked: lockedN, sec };
    if (!before || frozen) return;
    const say = (text: string, tone: CalloutTone = "plain") => setMoment({ id: ++nid.current, text, tone });
    const cell = (c: number, k: number) => worldRef.current?.querySelector<HTMLElement>(`[data-cell="${c}_${k}"]`);
    const born: Floater[] = [];
    let myHits = 0;
    for (let c = 0; c < COLUMNS; c++) {
      if (myMarks[c] === "hit" && before.me[c] !== "hit") {
        myHits++;
        born.push({ id: ++nid.current, c, k: mine[c], who: "me" });
        const el = cell(c, mine[c]);
        if (el) burstAt(el, { colors: BURST_ME, kind: "shards", count: 24, power: 1.1 });
        if (el) burstAt(el, { colors: ["#ffffff", "#9fc4ff"], kind: "sparks", count: 12 });
        const run = runEndingAt(myMarks, c);
        if (run >= 2) say(ordinalRun(run), "up");
        setAnnounce(`Hit in column ${c + 1}. ${HIT_POINTS} points.`);
      }
      if (foeMarks[c] === "hit" && before.foe[c] !== "hit") {
        born.push({ id: ++nid.current, c, k: theirs[c], who: "foe" });
        const el = cell(c, theirs[c]);
        if (el) burstAt(el, { colors: BURST_FOE, kind: "sparks", count: 10, power: 0.8 });
        setAnnounce(`The opponent hit in column ${c + 1}.`);
      }
    }
    if (myHits) sfx(myHits > 1 || runEndingAt(myMarks, myMarks.lastIndexOf("hit")) >= 3 ? "combo" : "clear");
    else if (foeMarks.some((m, c) => m === "hit" && before.foe[c] !== "hit")) sfx("check");
    if (born.length) {
      setFloaters((f) => [...f, ...born]);
      const ids = born.map((b) => b.id);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setFloaters((f) => f.filter((x) => !ids.includes(x.id)));
      }, 1300);
      timers.current.add(timer);
    }
    if (revealedN > before.revealed) sfx("flip");
    if (lockedN > before.locked && mine[lockedN - 1] !== NO_PICK) sfx("fill");
    if (before.sec < HEAD_START_SECS - 3 && sec >= HEAD_START_SECS - 3 && sec < HEAD_START_SECS) setCount("on");
    const last = MATCH_SECS - COLUMN_SECS;
    if (before.sec < last && sec >= last && sec < MATCH_SECS) say("Last column", "warn");
    if (sec > before.sec && sec >= MATCH_SECS - 5 && sec < MATCH_SECS) sfx("tick");
    const nl = nextLock(t);
    if (nl && sec > before.sec && nl.inSecs <= 6 && nl.inSecs > 5 && mine[nl.column] === NO_PICK) sfx("tick");
    // the marks and the clock second are the triggers; everything else is read fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  // ---- the end ----
  const [review, setReview] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const seenFinal = useRef(p.final);
  const outcome = p.final ? (p.final.you > p.final.them ? "won" : p.final.you < p.final.them ? "lost" : "draw") : null;
  useEffect(() => {
    const was = seenFinal.current;
    seenFinal.current = p.final;
    if (!p.final || was || !outcome) return;
    sfx(outcome === "won" ? "win" : outcome === "lost" ? "lose" : "chip");
    if (outcome === "won") {
      const r = endRef.current?.getBoundingClientRect();
      burst({ x: r ? r.left + r.width / 2 : window.innerWidth / 2, y: r ? r.top + 40 : 200, colors: BURST_ME.concat(["#b99bff"]), kind: "confetti", count: 90, power: 1.3 });
    }
  }, [p.final, outcome]);

  // ---- derived view state ----
  const states: ColumnState[] = Array.from({ length: COLUMNS }, (_, c) => columnState(c, t));
  const nl = nextLock(t);
  const nagCol = nl && nl.inSecs <= 8 && mine[nl.column] === NO_PICK ? nl.column : -1;
  const liveCol = states.indexOf("live");
  const timeLeft = MATCH_SECS - t;
  const phase: "head" | "play" | "last" | "over" = over ? "over" : t < HEAD_START_SECS ? "head" : t >= MATCH_SECS - COLUMN_SECS ? "last" : "play";
  const lead = score.you - score.them;
  const share = score.you + score.them === 0 ? 0.5 : score.you / (score.you + score.them);

  const edgesAt = Array.from({ length: win.hi - win.lo + 2 }, (_, i) => win.lo + i);
  const names = useRef({ key: "", by: new Map<number, string>() });
  const bandName = (k: number) => {
    const key = `${anchor}|${step}|${digits}`;
    if (names.current.key !== key) names.current = { key, by: new Map() };
    let n = names.current.by.get(k);
    if (n === undefined) {
      const b = bandEdges(k, anchor, step);
      n = `${money(usdOf(b.from))} to ${money(usdOf(b.to))}`;
      names.current.by.set(k, n);
    }
    return n;
  };
  const viewH = HEADER_PX + layout.bodyH;

  const header = (
    <header className="cut cut-card tg-bar">
      <div className="tg-bar-l">
        <h1 className="tg-title">{p.title ?? "Trading Duel"}</h1>
        <span className="cut cut-chip tg-asset">{asset} / USD</span>
        <span className={`tg-feed${p.stale ? " stale" : ""}`}>{p.stale ? "Price delayed" : "Live price"}</span>
      </div>
      <div className="tg-bar-r">
        {p.practice ? <span className="meta">Practice · nothing staked</span> : p.entry !== undefined && <span className="meta">Entry <b className="tnum">{p.entry}</b>{p.pot !== undefined && <> · Pot <b className="tnum">{p.pot}</b></>}</span>}
        <MuteToggle />
        <FullScreenToggle />
      </div>
    </header>
  );

  const side = (who: "me" | "foe", s: GridSide, pts_: number, m: Mark[]) => (
    <div className={`tg-side ${who}`}>
      <div className="tg-who">
        {s.avatar ? <Image className="cut tg-avatar" src={s.avatar} alt="" width={40} height={40} /> : <span className="cut tg-avatar tg-avatar-blank" aria-hidden="true" />}
        <div>
          <span className="tg-name">{s.name}</span>
          <span className="tg-sub">
            <span className={`tg-key ${who}`} aria-hidden="true" />
            {hitCount(m)} {hitCount(m) === 1 ? "hit" : "hits"}
          </span>
        </div>
      </div>
      <b key={pts_} className="tg-score tnum" aria-label={`${s.name}: ${pts_} points`}>{pts_}</b>
      <ol className="tg-tally" aria-label={`${s.name}'s columns`}>
        {m.map((x, c) => (
          <li key={c} className={x} title={`Column ${c + 1}: ${x === "hit" ? "hit" : x === "miss" ? "miss" : x === "pending" ? "to come" : x === "hidden" ? "hidden" : "no pick"}`}>
            <span className="sr-only">{x}</span>
          </li>
        ))}
      </ol>
    </div>
  );

  const scoreboard = (
    <section className="cut cut-card tg-scoreboard" aria-label="Score">
      {side("me", me, score.you, myMarks)}
      <div className="tg-vs">
        <span className={`cut cut-chip tg-lead${lead === 0 ? "" : lead > 0 ? " you" : " foe"}`}>{lead === 0 ? "Level" : lead > 0 ? `You lead by ${lead}` : `${p.opponent.name} leads by ${-lead}`}</span>
        <div className="tg-meter" role="img" aria-label={`You ${score.you}, ${p.opponent.name} ${score.them}`}>
          <i className="me" style={{ width: `${share * 100}%` }} />
          <i className="foe" style={{ width: `${(1 - share) * 100}%` }} />
          <s aria-hidden="true" style={{ left: `${share * 100}%` }} />
        </div>
      </div>
      {side("foe", p.opponent, score.them, foeMarks)}
    </section>
  );

  const strip = (() => {
    const secsNext = nl ? Math.ceil(nl.inSecs) : 0;
    const nag = nagCol >= 0;
    let text: ReactNode;
    let tone = "";
    if (phase === "over") text = settled ? "Final column done" : "Final column done · counting up";
    else if (phase === "head") text = <>Head start · the line enters column 1 in <b className="tnum">{Math.ceil(headStartLeft(t))}s</b></>;
    else if (phase === "last") text = <>Last column · <b className="tnum">{Math.max(0, Math.ceil(timeLeft))}s</b> to go</>;
    else text = <>Column {liveCol + 1} is live</>;
    if (nag && phase !== "over") tone = " nag";
    else if (phase === "last") tone = " last";
    return (
      <div className={`cut cut-card tg-strip${tone}`} role="status">
        <span className="tg-strip-main">{text}</span>
        {nl && phase !== "over" && (
          <span className="tg-strip-lock">
            {nag && <span className="tg-nag-ic" aria-hidden="true">!</span>}
            Column {nl.column + 1} locks in <b className="tnum">{secsNext}s</b>
            {nag ? " · no pick yet" : ""}
            <i className="tg-lockbar" aria-hidden="true"><s style={{ width: `${Math.min(100, (nl.inSecs / (COLUMN_SECS * 2)) * 100)}%` }} /></i>
          </span>
        )}
        {phase !== "over" && <span className="tg-strip-clock tnum">{fmtClock(Math.max(0, timeLeft))} left</span>}
      </div>
    );
  })();

  const worldW = WORLD_COLS * cw;
  const worldStyle = { width: worldW, "--tg-cw": `${cw}px`, "--tg-rh": `${rh}px`, "--tg-hd": `${HEADER_PX}px`, "--tg-bh": `${layout.bodyH}px` } as CSSProperties;

  return (
    <Arena game="trading-duel">
      <section className="tg" aria-label={p.title ?? "Trading Duel"} data-phase={phase}>
        {header}
        {p.banner}
        {scoreboard}
        {strip}
        {p.error && <p className="tg-error" role="alert">{p.error}</p>}

        <div ref={stageRef} className="cut cut-frame tg-stage" role="group" onKeyDown={onStageKey} aria-label={`Price grid, ${asset}. Pick a box in a column that is still open. Arrow keys move between boxes, Enter or Space picks.`}>
          <div className="tg-gutter" style={{ height: viewH }} aria-hidden="true">
            <div className="tg-gbody" style={{ top: HEADER_PX, height: layout.bodyH }}>
              <div className="tg-gvl" ref={gvlRef}>
                {edgesAt.map((e) => (
                  <span key={e} className={`tg-gl${e === 0 ? " start" : ""}`} data-e={e} style={{ top: -e * rh }}>
                    {money(anchorUsd + e * stepUsd)}
                  </span>
                ))}
              </div>
              <div className="tg-ptr" ref={ptrRef}>
                <span ref={ptrTextRef} className="tg-ptr-t" data-dir="flat" />
              </div>
            </div>
          </div>


          <div
            className="tg-view"
            ref={viewRef}
            style={{ height: viewH }}
            onPointerDown={onViewDown}
            onPointerMove={onViewMove}
            onPointerUp={onViewUp}
            onPointerCancel={onViewUp}
            onClickCapture={(e) => {
              if (drag.current.moved) {
                e.stopPropagation();
                e.preventDefault();
              }
            }}
          >
            <div className="tg-world" ref={worldRef} style={worldStyle} data-compact={cw < 76 || undefined}>
              <div className="tg-cols">
                <div className="tg-pad" style={{ width: PAD_COLS * cw }}>
                  <div className="tg-pad-head">Head start</div>
                  <div className="tg-pad-body" ref={padRef}>
                    <p className="tg-pad-title">Pick where the price will be.</p>
                    <p className="tg-pad-sub">Hit the box when the line passes.</p>
                    <p className="tg-pad-n tnum" aria-hidden="true">{Math.ceil(headStartLeft(t)) || ""}</p>
                  </div>
                </div>

                {Array.from({ length: COLUMNS }, (_, c) => {
                  const st = states[c];
                  const nag = c === nagCol;
                  const lockIn = nl && nl.column === c ? Math.ceil(nl.inSecs) : null;
                  return (
                    <div key={c} className={`tg-col ${st}${nag ? " nag" : ""}${c === liveCol ? " now" : ""}`} style={{ width: cw }} data-col={c}>
                      <div className="tg-colhead">
                        <b className="tg-cn tnum">{c + 1}</b>
                        <span className="tg-cs">
                          {st === "open" ? (lockIn !== null && lockIn <= 12 ? (cw < 100 ? `${lockIn}s` : `Locks ${lockIn}s`) : "Open") : st === "locked" ? (
                            <>
                              <LockIcon width={11} height={11} /> {cw < 100 ? "" : "Locked"}
                            </>
                          ) : st === "live" ? "Live" : ""}
                        </span>
                        {st === "done" && (
                          <span className="tg-cr" aria-hidden="true">
                            <i className={`me ${myMarks[c]}`} />
                            <i className={`foe ${foeMarks[c]}`} />
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="tg-body" style={{ top: HEADER_PX, height: layout.bodyH }}>
                <div className="tg-fx" aria-hidden="true">
                  <div className="tg-wake" ref={wakeRef} />
                  <div className="tg-nowline" ref={nowRef} />
                </div>
                <div className="tg-vl" ref={vlRef}>
                  {Array.from({ length: COLUMNS }, (_, c) => {
                    const st = states[c];
                    const open = st === "open";
                    const range = touchedBands(track, c, anchor, step);
                    const nag = c === nagCol;
                    const ks = new Set<number>();
                    for (let k = win.lo; k <= win.hi; k++) ks.add(k);
                    if (tab.c === c) ks.add(tab.k);
                    return [...ks].map((k) => {
                      const isMine = mine[c] === k;
                      const isFoe = theirs[c] === k;
                      const touched = !!range && k >= range[0] && k <= range[1];
                      const lit = `${isMine && myMarks[c] === "hit" ? " lit-me" : ""}${isFoe && foeMarks[c] === "hit" ? " lit-foe" : ""}`;
                      return (
                        <Cell
                          key={`${c}_${k}`}
                          c={c}
                          k={k}
                          left={columnX(c, cw)}
                          top={-(k + 1) * rh}
                          w={cw}
                          h={rh}
                          cls={`${k === 0 ? " anchor" : ""}${touched ? " touched" : ""}${lit}${open ? " can" : ""}${isMine || isFoe ? " has" : ""}${nag ? " nag" : ""}`}
                          label={bandName(k)}
                          mine={isMine}
                          foe={isFoe}
                          myMark={myMarks[c]}
                          foeMark={foeMarks[c]}
                          state={st}
                          here={tab.c === c && tab.k === k}
                          off={!open || settled}
                          on={cell}
                        />
                      );
                    });
                  })}

                  <div className="tg-field" aria-hidden="true">
                    <svg className="tg-snake" width={worldW} height={1} viewBox={`0 0 ${worldW} 1`}>
                      {bands.map((b, c) => b && <rect key={c} className={`tg-band ${states[c]}`} x={b.x} y={b.y} width={b.w} height={b.h} />)}
                    </svg>
                    <div className="tg-head" ref={headRef}>
                      <i ref={dotRef} className="tg-head-dot" data-dir="flat" />
                      <span ref={chipRef} className="cut cut-chip tg-head-chip" data-dir="flat">
                        <span ref={chipTextRef} /> <em ref={chipArrowRef} />
                      </span>
                    </div>
                    {floaters.map((f) => (
                      <span key={f.id} className={`tg-float ${f.who}`} style={{ left: columnX(f.c, cw), top: -(f.k + 1) * rh, width: cw, height: rh }}>
                        +{HIT_POINTS}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="tg-edges">
                  {edges.map((e) => {
                    const same = edges.filter((x) => x.c === e.c && x.dir === e.dir);
                    const slot = same.findIndex((x) => x.who === e.who);
                    const word = e.who === "me" ? "your pick" : "their pick";
                    return (
                      <button
                        key={`${e.c}${e.who}`}
                        type="button"
                        className={`cut cut-chip tg-edge ${e.who} ${e.dir > 0 ? "up" : "down"}`}
                        style={{ left: columnX(e.c, cw) + 3, width: cw - 6, [e.dir > 0 ? "top" : "bottom"]: 4 + slot * 24 }}
                        aria-label={`Column ${e.c + 1}: ${e.who === "me" ? "your" : "the opponent's"} pick is ${e.dir > 0 ? "above" : "below"} the view. Show it.`}
                        title={`${e.who === "me" ? "Your" : "Their"} pick is ${e.dir > 0 ? "above" : "below"}: show it`}
                        onClick={() => showPick(e.k)}
                      >
                        <span aria-hidden="true">{e.dir > 0 ? "▲" : "▼"}</span>
                        <span className="tg-edge-w">{word}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <LiveButton
              away={panned}
              onGo={goLive}
              bind={bindLive}
              viewW={viewW}
              bodyH={layout.bodyH}
              zoom={{ out: () => zoomBy(1 / ZOOM_STEP), in: () => zoomBy(ZOOM_STEP), atMin, atMax }}
            />
            <canvas ref={canvasRef} className="tg-line" aria-hidden="true" style={{ top: HEADER_PX, width: viewW, height: layout.bodyH }} />
            <div className="tg-fade l" aria-hidden="true" />
            <div className="tg-fade r" aria-hidden="true" />
            {count === "on" && <Countdown from={3} goText="Go!" onEnd={() => setCount("done")} />}
            {moment && <Callout key={moment.id} text={moment.text} tone={moment.tone} onDone={() => setMoment((m) => (m?.id === moment.id ? null : m))} />}
          </div>

          {outcome && !review && p.final && (
            <div className="tg-end">
              <div ref={endRef} className={`cut cut-frame tg-end-panel ${outcome}`} role="dialog" aria-label="Game over">
                <span className="label">{p.practice ? "Practice over" : "Match over"}</span>
                <h2 className="tg-end-title">{outcome === "won" ? "You won" : outcome === "lost" ? "You lost" : "A draw"}</h2>
                <p className="tg-end-score tnum">
                  <b className="you">{p.final.you}</b>
                  <span aria-hidden="true">–</span>
                  <b className="foe">{p.final.them}</b>
                </p>
                <p className="meta">
                  You hit {hitCount(myMarks)} of {COLUMNS} columns · {p.opponent.name} hit {hitCount(foeMarks)}
                </p>
                {p.payingOut && <p className="meta" role="status">Paying out…</p>}
                {p.practice ? (
                  <p className="meta">Practice: nothing was staked and no Gemas moved.</p>
                ) : (
                  p.pot !== undefined && (
                    <p className={`tg-pot${outcome === "won" ? " won" : ""}`}>
                      {outcome === "won" ? "You take the Pot" : outcome === "draw" ? "Entries returned" : "Pot goes to your opponent"}
                      <span className="tnum">
                        <GemaMark size={18} /> {outcome === "draw" && p.entry !== undefined ? p.entry : p.pot}
                      </span>
                    </p>
                  )
                )}
                <div className="tg-end-actions">
                  {p.onPlayAgain && <Button onClick={p.onPlayAgain}>Play again</Button>}
                  {p.exitHref && <Button href={p.exitHref}>{p.exitLabel ?? "Lobby"}</Button>}
                  <button type="button" className="cut cut-btn tg-review" onClick={() => setReview(true)}>Review the grid</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <ul className="tg-legend" aria-label="Key">
          <li><i className="tg-key me" aria-hidden="true" /> Your pick</li>
          <li><i className="tg-key foe" aria-hidden="true" /> Opponent&apos;s pick (shown when a column locks)</li>
          <li><CheckIcon width={13} height={13} /> Hit · {HIT_POINTS} points</li>
          <li><XIcon width={13} height={13} /> Miss</li>
          <li><LockIcon width={13} height={13} /> Locked {LOCK_AHEAD_SECS}s before the line arrives</li>
          <li>Drag or scroll to look at other prices · Live to come back</li>
        </ul>
        <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      </section>
    </Arena>
  );
}

interface CellHandlers {
  pick: (c: number, k: number) => void;
  key: (e: KeyboardEvent<HTMLButtonElement>, c: number, k: number) => void;
  focus: (c: number, k: number) => void;
}

interface CellProps {
  c: number;
  k: number;
  left: number;
  top: number;
  w: number;
  h: number;
  cls: string;
  label: string;
  mine: boolean;
  foe: boolean;
  myMark: Mark;
  foeMark: Mark;
  state: ColumnState;
  here: boolean;
  off: boolean;
  on: CellHandlers;
}

/** One box. Memoised on plain values so the once-a-second render only touches the boxes that changed. */
const Cell = memo(function Cell({ c, k, left, top, w, h, cls, label, mine, foe, myMark, foeMark, state, here, off, on }: CellProps) {
  const hit = mine && myMark === "hit";
  return (
    <button
      type="button"
      data-cell={`${c}_${k}`}
      className={`tg-cell${cls}`}
      style={{ left, top, width: w, height: h }}
      aria-label={`Column ${c + 1}, ${label}${mine ? ", your pick" : ""}${foe ? ", opponent's pick" : ""}${hit ? ", hit" : ""}`}
      aria-pressed={mine}
      aria-disabled={off}
      tabIndex={here ? 0 : -1}
      onFocus={() => on.focus(c, k)}
      onKeyDown={(e) => on.key(e, c, k)}
      onClick={() => on.pick(c, k)}
    >
      {(mine || foe) && (
        <span className={`tg-marks${mine && foe ? " both" : ""}`}>
          {mine && <Marker who="me" m={myMark} state={state} />}
          {foe && <Marker who="foe" m={foeMark} state={state} />}
        </span>
      )}
    </button>
  );
});

function Marker({ who, m, state }: { who: "me" | "foe"; m: Mark; state: ColumnState }) {
  const icon = m === "hit" ? <CheckIcon width={16} height={16} /> : m === "miss" ? <XIcon width={14} height={14} /> : state === "locked" && who === "me" ? <LockIcon width={13} height={13} /> : <i className="tg-diamond" />;
  return (
    <span className={`cut tg-mark ${who} ${m} ${state}`} style={{ "--c": "7px" } as CSSProperties}>
      {icon}
    </span>
  );
}
