"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Button, CheckIcon, GemaMark, LockIcon, XIcon } from "@/components/ui";
import { Arena, Callout, Countdown, MuteToggle, burst, burstAt, sfx, useReducedMotion, type CalloutTone } from "../fx";
import {
  COLUMNS,
  COLUMN_SECS,
  HEAD_START_SECS,
  HIT_POINTS,
  LOCK_AHEAD_SECS,
  MATCH_SECS,
  NO_PICK,
  ROWS,
  canPick,
  columnState,
  headStartLeft,
  lockAt,
  nextLock,
  rowBand,
  type ColumnState,
  type GridAsset,
  type Track,
} from "./grid";
import { HEADER_PX, PAD_COLS, WORLD_COLS, cameraX, columnX, hitCount, layoutFor, marks, priceDigits, runEndingAt, snakePath, snakePoints, touchedRows, xOf, yOf, type Mark } from "./gridView";
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
  /** Start price and row height in 1e-8 USD: what `grid.ts` calls `anchor` and `step`. */
  anchor: bigint;
  step: bigint;
  /** When the head start begins, ms. The clock runs from here. */
  startsAt: number;
  /** What the line did in each column (`record` / `finish` in grid.ts). */
  track: Track;
  /** Recent prices for the snake; samples before `startsAt` are ignored. */
  series: GridPoint[];
  /** The latest price in 1e-8 USD; null while waiting for the first one. */
  price: bigint | null;
  /** The price feed has gone quiet. */
  stale?: boolean;
  /** Your row for each of the 12 columns, `NO_PICK` where you have none. */
  mine: number[];
  /** The opponent's row per column: `NO_PICK` until the column locks and their pick is revealed. */
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
  /** Pick a box; `row` is `NO_PICK` when you tap your own pick again to clear it. */
  onPick: (column: number, row: number) => void;
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

type Floater = { id: number; c: number; r: number; who: "me" | "foe" };
type Moment = { id: number; text: string; tone: CalloutTone };

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
 * The Trading Duel play screen: a 12 column by 8 row price grid that scrolls under a glowing line (the snake).
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
  const layout = useMemo(() => layoutFor(viewW), [viewW]);
  const { cw, rh } = layout;

  const myMarks = useMemo(() => marks(track, mine, t, anchor, step), [track, mine, t, anchor, step]);
  const foeMarks = useMemo(() => marks(track, theirs, t, anchor, step, true), [track, theirs, t, anchor, step]);
  const score = p.final ?? { you: hitCount(myMarks) * HIT_POINTS, them: hitCount(foeMarks) * HIT_POINTS };
  const over = t >= MATCH_SECS;
  const settled = !!p.final;

  const pts = useMemo(() => snakePoints(p.series, startsAt, anchorUsd), [p.series, startsAt, anchorUsd]);
  const base = useMemo(() => snakePath(pts, layout, anchorUsd, stepUsd), [pts, layout, anchorUsd, stepUsd]);
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
  const dir: "up" | "down" | "flat" = useMemo(() => {
    const last = pts[pts.length - 1];
    for (let i = pts.length - 2; i >= 0 && i > pts.length - 10; i--) if (pts[i].p !== last.p) return last.p > pts[i].p ? "up" : "down";
    return "flat";
  }, [pts]);
  const priceUsd = p.price !== null ? usdOf(p.price) : pts[pts.length - 1].p;

  // ---- the moving parts are written straight to the DOM every frame (no React render per frame) ----
  const worldRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const wakeRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useRef({ layout, base, pts, startsAt, stepped: reduced, anchorUsd, stepUsd, hy: null as number | null, last: 0 });
  useEffect(() => {
    live.current = { ...live.current, layout, base, pts, startsAt, stepped: reduced, anchorUsd, stepUsd };
  });
  const gradId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const frozen = p.nowMs !== undefined;
  useEffect(() => {
    const apply = (ms: number, snapHead: boolean) => {
      const L = live.current;
      const secs = (ms - L.startsAt) / 1000;
      const dt = Math.min(0.1, Math.max(0.001, (ms - L.last) / 1000 || 0.016));
      L.last = ms;
      const cam = cameraX(secs, L.layout, L.stepped);
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${-cam}px,0,0)`;
      const lastPt = L.pts[L.pts.length - 1];
      const targetY = yOf(lastPt.p, L.anchorUsd, L.stepUsd, L.layout.rh);
      const hy = L.hy === null || snapHead ? targetY : L.hy + (targetY - L.hy) * Math.min(1, dt * 7);
      L.hy = hy;
      const hx = xOf(secs, L.layout.cw);
      const tail = hx > L.base.x + 0.5 ? `L${hx.toFixed(1)} ${hy.toFixed(1)}` : "";
      const d = L.base.d + tail;
      pathRef.current?.setAttribute("d", d);
      glowRef.current?.setAttribute("d", d);
      gradRef.current?.setAttribute("x1", String(Math.max(0, hx - L.layout.cw * 3.2)));
      gradRef.current?.setAttribute("x2", String(hx));
      if (headRef.current) {
        headRef.current.style.transform = `translate3d(${hx}px,${hy}px,0)`;
        headRef.current.classList.toggle("low", hy < 46);
      }
      stageRef.current?.querySelectorAll<HTMLElement>(".tg-gl").forEach((el) => el.classList.toggle("near", Math.abs(Number(el.dataset.y) - hy) < 15));
      if (nowRef.current) nowRef.current.style.transform = `translate3d(${hx}px,0,0)`;
      if (ptrRef.current) ptrRef.current.style.transform = `translate3d(0,${hy}px,0)`;
      if (wakeRef.current) {
        const c = Math.floor((secs - HEAD_START_SECS) / COLUMN_SECS);
        const x0 = secs < HEAD_START_SECS ? 0 : columnX(Math.min(COLUMNS - 1, Math.max(0, c)), L.layout.cw);
        wakeRef.current.style.transform = `translate3d(${x0}px,0,0)`;
        wakeRef.current.style.width = `${Math.max(0, hx - x0)}px`;
        wakeRef.current.style.opacity = secs >= MATCH_SECS ? "0" : "1";
      }
    };
    if (frozen) {
      apply(p.nowMs!, true);
      return;
    }
    if (reduced) {
      apply(Date.now(), true);
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
  }, [frozen, p.nowMs, reduced, layout, base]);

  // ---- picking ----
  const [fc, setFc] = useState<{ c: number; r: number } | null>(null);
  // The arrow keys only visit columns you can still pick that are on screen.
  const cam = cameraX(t, layout, reduced);
  const reachable = (c: number) => canPick(c, t) && columnX(c, cw) + cw / 2 > cam && columnX(c, cw) + cw / 2 < cam + viewW;
  const firstOpen = Math.max(0, Math.min(COLUMNS - 1, Array.from({ length: COLUMNS }, (_, c) => c).find(reachable) ?? nextLock(t)?.column ?? COLUMNS - 1));
  const tab = fc && reachable(fc.c) ? fc : { c: firstOpen, r: mine[firstOpen] !== NO_PICK ? mine[firstOpen] : 3 };
  const pick = (c: number, r: number) => {
    if (!canPick(c, (wallNow() - startsAt) / 1000) || settled) return;
    sfx("chip");
    onPick(c, mine[c] === r ? NO_PICK : r);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, c: number, r: number) => {
    const move: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    let nc = c;
    if (m[0]) {
      nc = c + m[0];
      while (nc >= 0 && nc < COLUMNS && !reachable(nc)) nc += m[0];
      if (nc < 0 || nc >= COLUMNS) return;
    }
    const nr = Math.max(0, Math.min(ROWS - 1, r + m[1]));
    setFc({ c: nc, r: nr });
    worldRef.current?.querySelector<HTMLElement>(`[data-cell="${nc}-${nr}"]`)?.focus();
  };

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
    const cell = (c: number, r: number) => worldRef.current?.querySelector<HTMLElement>(`[data-cell="${c}-${r}"]`);
    const born: Floater[] = [];
    let myHits = 0;
    for (let c = 0; c < COLUMNS; c++) {
      if (myMarks[c] === "hit" && before.me[c] !== "hit") {
        myHits++;
        born.push({ id: ++nid.current, c, r: mine[c], who: "me" });
        const el = cell(c, mine[c]);
        if (el) burstAt(el, { colors: BURST_ME, kind: "shards", count: 24, power: 1.1 });
        if (el) burstAt(el, { colors: ["#ffffff", "#9fc4ff"], kind: "sparks", count: 12 });
        const run = runEndingAt(myMarks, c);
        if (run >= 2) say(ordinalRun(run), "up");
        setAnnounce(`Hit in column ${c + 1}. ${HIT_POINTS} points.`);
      }
      if (foeMarks[c] === "hit" && before.foe[c] !== "hit") {
        born.push({ id: ++nid.current, c, r: theirs[c], who: "foe" });
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

  const labels = Array.from({ length: ROWS - 1 }, (_, i) => {
    const k = i + 1;
    return { k, v: anchorUsd + (k - 4) * stepUsd };
  });
  const rowName = (r: number) => {
    const b = rowBand(r, anchor, step);
    return b.from === null ? `below ${money(usdOf(b.to!))}` : b.to === null ? `above ${money(usdOf(b.from))}` : `${money(usdOf(b.from))} to ${money(usdOf(b.to))}`;
  };

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
  const worldStyle = { width: worldW, "--tg-cw": `${cw}px`, "--tg-rh": `${rh}px`, "--tg-hd": `${HEADER_PX}px` } as CSSProperties;

  return (
    <Arena game="trading-duel">
      <section className="tg" aria-label={p.title ?? "Trading Duel"} data-phase={phase}>
        {header}
        {p.banner}
        {scoreboard}
        {strip}
        {p.error && <p className="tg-error" role="alert">{p.error}</p>}

        <div ref={stageRef} className="cut cut-frame tg-stage" role="group" aria-label={`Price grid, ${asset}. Pick a box in a column that is still open. Arrow keys move between boxes, Enter or Space picks.`}>
          <div className="tg-gutter" style={{ height: HEADER_PX + ROWS * rh }} aria-hidden="true">
            <span className="tg-gl-end" style={{ top: HEADER_PX + rh * 0.5 }}>above</span>
            <span className="tg-gl-end" style={{ top: HEADER_PX + rh * (ROWS - 0.5) }}>below</span>
            {labels.map((l) => (
              <span key={l.k} className={`tg-gl${l.k === 4 ? " start" : ""}`} data-y={(ROWS - l.k) * rh} style={{ top: HEADER_PX + (ROWS - l.k) * rh }}>
                {money(l.v)}
              </span>
            ))}
            <div className="tg-ptr" ref={ptrRef} style={{ top: HEADER_PX }}>
              <span className={`tg-ptr-t ${dir}`}>{money(priceUsd)}{dir === "up" ? " ▲" : dir === "down" ? " ▼" : ""}</span>
            </div>
          </div>

          <div className="tg-view" ref={viewRef} style={{ height: HEADER_PX + ROWS * rh }}>
            <div className="tg-world" ref={worldRef} style={worldStyle}>
              <div className="tg-pad" style={{ width: PAD_COLS * cw }}>
                <div className="tg-pad-head">Head start</div>
                <div className="tg-pad-body" style={{ height: ROWS * rh }}>
                  <p className="tg-pad-title">Pick where the price will be.</p>
                  <p className="tg-pad-sub">Hit the box when the line passes.</p>
                  <p className="tg-pad-n tnum" aria-hidden="true">{Math.ceil(headStartLeft(t)) || ""}</p>
                </div>
              </div>

              {Array.from({ length: COLUMNS }, (_, c) => {
                const st = states[c];
                const open = st === "open";
                const range = touchedRows(track, c, anchor, step);
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
                    {Array.from({ length: ROWS }, (_, i) => {
                      const r = ROWS - 1 - i;
                      const isMine = mine[c] === r;
                      const isFoe = theirs[c] === r;
                      const touched = !!range && r >= range[0] && r <= range[1];
                      const here = tab.c === c && tab.r === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          data-cell={`${c}-${r}`}
                          className={`tg-cell${r === 4 ? " anchor" : ""}${touched ? " touched" : ""}${isMine && myMarks[c] === "hit" ? " lit-me" : ""}${isFoe && foeMarks[c] === "hit" ? " lit-foe" : ""}${open ? " can" : ""}${isMine || isFoe ? " has" : ""}`}
                          aria-label={`Column ${c + 1}, ${rowName(r)}${isMine ? ", your pick" : ""}${isFoe ? ", opponent's pick" : ""}${isMine && myMarks[c] === "hit" ? ", hit" : ""}`}
                          aria-pressed={isMine}
                          aria-disabled={!open || settled}
                          tabIndex={here ? 0 : -1}
                          onFocus={() => setFc({ c, r })}
                          onKeyDown={(e) => onKey(e, c, r)}
                          onClick={() => pick(c, r)}
                        >
                          {(isMine || isFoe) && (
                            <span className={`tg-marks${isMine && isFoe ? " both" : ""}`}>
                              {isMine && <Marker who="me" m={myMarks[c]} state={st} />}
                              {isFoe && <Marker who="foe" m={foeMarks[c]} state={st} />}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              <div className="tg-field" style={{ top: HEADER_PX, height: ROWS * rh }} aria-hidden="true">
                <div className="tg-wake" ref={wakeRef} />
                <svg className="tg-snake" width={worldW} height={ROWS * rh} viewBox={`0 0 ${worldW} ${ROWS * rh}`}>
                  <defs>
                    <linearGradient id={`g${gradId}`} ref={gradRef} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={worldW} y2="0">
                      <stop offset="0" stopColor="#eaf1fb" stopOpacity="0.08" />
                      <stop offset="0.7" stopColor="#eaf1fb" stopOpacity="0.7" />
                      <stop offset="1" stopColor="#ffffff" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  {bands.map((b, c) => b && <rect key={c} className={`tg-band ${states[c]}`} x={b.x} y={b.y} width={b.w} height={b.h} />)}
                  <path ref={glowRef} className="tg-snake-glow" d={base.d} stroke={`url(#g${gradId})`} />
                  <path ref={pathRef} className="tg-snake-core" d={base.d} stroke={`url(#g${gradId})`} />
                </svg>
                <div className="tg-nowline" ref={nowRef} />
                <div className="tg-head" ref={headRef}>
                  <i className={`tg-head-dot ${dir}`} />
                  <span className={`cut cut-chip tg-head-chip ${dir}`}>
                    {money(priceUsd)} <em>{dir === "up" ? "▲" : dir === "down" ? "▼" : "◆"}</em>
                  </span>
                </div>
                {floaters.map((f) => (
                  <span key={f.id} className={`tg-float ${f.who}`} style={{ left: columnX(f.c, cw), top: (ROWS - 1 - f.r) * rh, width: cw, height: rh }}>
                    +{HIT_POINTS}
                  </span>
                ))}
              </div>
            </div>
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
        </ul>
        <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      </section>
    </Arena>
  );
}

function Marker({ who, m, state }: { who: "me" | "foe"; m: Mark; state: ColumnState }) {
  const icon = m === "hit" ? <CheckIcon width={16} height={16} /> : m === "miss" ? <XIcon width={14} height={14} /> : state === "locked" && who === "me" ? <LockIcon width={13} height={13} /> : <i className="tg-diamond" />;
  return (
    <span className={`cut tg-mark ${who} ${m} ${state}`} style={{ "--c": "7px" } as CSSProperties}>
      {icon}
    </span>
  );
}
