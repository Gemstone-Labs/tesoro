"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useGuideHidden } from "@/components/guide/Guide";
import { Button, CountUp, GemaMark, Label } from "@/components/ui";
import { PlayerAvatar } from "@/components/account/Player";
import { useAccount } from "@/lib/account";
import { Rows3, Vibrate, Zap } from "lucide-react";
import { apply, EngineFailure, MAX_MOVES, SIZE, dims, fitsAnywhere, handBase, newState, pieceAt, pieceCells } from "./engine";
import type { Piece, State } from "./engine";
import { Arena, Countdown, GameMenu, burst, prefersReducedMotion, sfx } from "../fx";
import type { CalloutTone } from "../fx";
import { clearCallout, comboHeat } from "./feel";
import { readBest, writeBest } from "./best";
import { PracticePauseButton, PracticePauseOverlay, usePracticePause } from "../fx/PracticePause";
import { blockHaptics } from "./haptics";
import { usePieceDrag } from "./use-piece-drag";
import { measureGrid } from "./drag-geometry";
import { blockSound } from "../fx/sfx";
import { useTransientEffects } from "./use-transient-effects";
import { useBoardPreview } from "./use-board-preview";
import { createScorePresentation } from "./score-presentation";
import { VibrationCheck } from "./VibrationCheck";
import "./block-puzzle.css";

const DURATION_MS = 90_000;
const CLEAR_MS = 450;
const DROP_MS = 280;
const BLOCK_HEX = ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"];
const GEM_HEX = ["#6af8d6", "#24d8a8", "#c8fff0"];
const NO_COLOR = 255;

type Phase = "idle" | "count" | "play" | "over";
type Reason = "time" | "stuck" | "limit";

interface Ghost {
  id: number;
  i: number;
  color: number;
  gem: boolean;
  /** Stagger (ms) so the clear ripples out from the piece. */
  delay: number;
}
interface Sweep {
  id: number;
  axis: "row" | "col";
  at: number;
}
interface Moment {
  id: number;
  text: string;
  tone: CalloutTone;
  y: number;
  combo?: number;
}
interface Game {
  st: State;
  colors: number[];
  lines: number;
  gemsCleared: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtClock = (ms: number) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
const colorOf = (p: Piece) => p.kind % 4;

function randomSeed(): bigint {
  const b = new BigUint64Array(1);
  crypto.getRandomValues(b);
  return b[0];
}

/** Top-left anchor for `piece` centred on cell (cx, cy), clamped inside the board. */
function anchorFor(piece: Piece, cx: number, cy: number): { x: number; y: number } {
  const [w, h] = dims(piece);
  const x = Math.min(Math.max(cx - Math.floor(w / 2), 0), SIZE - w);
  const y = Math.min(Math.max(cy - Math.floor(h / 2), 0), SIZE - h);
  return { x, y };
}

function PieceArt({ piece, cell, gap = 2 }: { piece: Piece; cell: number; gap?: number }) {
  const [w, h] = dims(piece);
  return (
    <span
      className="bp-mini"
      style={{ gap, gridTemplateColumns: `repeat(${w}, ${cell}px)`, gridTemplateRows: `repeat(${h}, ${cell}px)` }}
      aria-hidden="true"
    >
      {pieceCells(piece).map((c) => (
        <i
          key={`${c.dx}${c.dy}`}
          className={`bp-cell k${colorOf(piece)}${c.gem ? " gem" : ""}`}
          style={{ gridColumn: c.dx + 1, gridRow: c.dy + 1 }}
        />
      ))}
    </span>
  );
}

/** Wires a game to an on-chain Match: the Seed comes from the chain and every placement is reported. */
export interface MatchRun {
  seed: bigint;
  /** `performance.now()` taken just before `begin_run` was sent: the 90 s clock counts from here. */
  startedAt: number;
  entry: number;
  onMove: (move: { piece: number; x: number; y: number }) => void;
  onEnd: (final: { score: number; moves: number; reason: Reason }) => void;
}

export type { Reason as RunEndReason };

const fmtN = (n: number) => n.toLocaleString("en-US");
const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The Block Burst play screen: a versus bar (you and your score, the 90 s ring, the Pot or PRACTICE), the board, the tray,
 * then combo and lines as icons with numbers. No sentences during play; sound and full screen sit in the ⋯ menu. Recent
 * clears show on the game-over card. No character anywhere on it. `matchPanel` is the Match status the
 * caller owns (who we wait for); without a `run` this is practice.
 */
export function BlockPuzzleGame({ run, matchPanel }: { run?: MatchRun; matchPanel?: ReactNode }) {
  const { paused, toggle: togglePause, now: practiceNow } = usePracticePause(() => performance.now());
  const me = useAccount().snapshot?.accountKey.toBase58();
  const [phase, setPhase] = useState<Phase>("idle");
  const [combo, setCombo] = useState(0);
  useGuideHidden(phase === "play");
  const [reason, setReason] = useState<Reason>("time");
  const [game, setGame] = useState<Game>(() => ({ st: newState(0n), colors: [], lines: 0, gemsCleared: 0 }));
  const [sel, setSel] = useState(0);
  const [remaining, setRemaining] = useState(DURATION_MS);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [bestCombo, setBestCombo] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [fizzle, setFizzle] = useState(0);
  const [runId, setRunId] = useState(0);
  const [best, setBest] = useState({ value: 0, fresh: false, set: false });
  const [focusCell, setFocusCell] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [goOn, setGoOn] = useState(false);

  const endsAt = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const spaceRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef(game);
  const comboRef = useRef(0);
  const accepting = useRef(false);
  const { later, animate, reset: resetEffects } = useTransientEffects();
  const vibration = useSyncExternalStore(blockHaptics.subscribe, blockHaptics.enabled, () => true);
  const supportsVibration = useSyncExternalStore(blockHaptics.subscribe, blockHaptics.supported, () => false);
  const [checkingVibration, setCheckingVibration] = useState(false);
  const resumeAfterCheck = useRef(false);
  const gameItems = [...(supportsVibration ? [{
    label: vibration ? "Vibration on" : "Vibration off",
    icon: <Vibrate aria-hidden="true" />,
    checked: vibration,
    keepOpen: true,
    onSelect: () => { blockHaptics.setEnabled(!vibration); if (!vibration) blockHaptics.play(0, 0); },
  }] : []), ...(!run ? [{
    label: "Test vibration", icon: <Vibrate aria-hidden="true" />,
    onSelect: () => {
      resumeAfterCheck.current = phase === "play" && !paused;
      if (resumeAfterCheck.current) { onTrayCancel(); togglePause(); }
      setCheckingVibration(true);
    },
  }] : [])];
  const popupId = useRef(0);
  const scoreEl = useRef<HTMLSpanElement>(null);
  const scoreAura = useRef<HTMLSpanElement>(null);
  const [scoreReceipt, setScoreReceipt] = useState({total: 0, impact: 0});
  const [scorePresentation] = useState(() => createScorePresentation((total, impact) => setScoreReceipt({total, impact})));
  useEffect(() => {
    const { impact } = scoreReceipt;
    if (!impact || prefersReducedMotion()) return;
    if (scoreEl.current) animate(scoreEl.current, [
      { transform: `scale(${impact > 1 ? 1.16 : 1.07})` },
      { transform: "scale(1)" },
    ], { duration: impact > 1 ? 280 : 170, easing: "cubic-bezier(.16,1,.3,1)" });
    if (scoreAura.current) animate(scoreAura.current, [
      { opacity: impact > 1 ? 0.85 : 0.35, transform: "rotate(45deg) scale(.65)" },
      { opacity: 0, transform: "rotate(45deg) scale(1.2)" },
    ], { duration: impact > 1 ? 420 : 240, easing: "ease-out" });
  }, [scoreReceipt, animate]);
  useEffect(() => () => scorePresentation.dispose(), [scorePresentation]);


  const { st } = game;
  const base = handBase(st);
  const hand = useMemo(() => [0, 1, 2].map((n) => pieceAt(st.seed, base + n)), [st.seed, base]);
  const available = useMemo(() => hand.map((piece) => fitsAnywhere(st, piece)), [hand, st]);
  const selPiece = phase === "play" && (st.used >> (sel - base)) & 1 ? null : hand[sel - base] ?? null;

  const setPreview = useBoardPreview(boardRef, st, selPiece);

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const scoreRef = useRef({ score: 0, moves: 0 });
  const finish = useCallback((why: Reason, final?: Game) => {
    const st = final?.st;
    runRef.current?.onEnd({ score: st?.score ?? scoreRef.current.score, moves: st?.moves ?? scoreRef.current.moves, reason: why });
    accepting.current = false;
    resetEffects();
    scorePresentation.settle(st?.score ?? scoreRef.current.score);
    setMoment(null); setGhosts([]); setSweeps([]);
    setPhase("over");
    setReason(why);
    if (!runRef.current) {
      const score = st?.score ?? scoreRef.current.score;
      const prev = readBest();
      const fresh = score > prev;
      if (fresh) writeBest(score);
      setBest({ value: fresh ? score : prev, fresh, set: true });
      if (fresh) {
        sfx("win");
        const box = boardRef.current?.getBoundingClientRect();
        if (box) burst({ x: box.left + box.width / 2, y: box.top + box.height * 0.4, colors: BLOCK_HEX, kind: "confetti", count: 60, power: 1.4 });
      }
    }
    setPreview(null);
    if (final) { gameRef.current = final; setGame(final); }
  }, [setPreview, scorePresentation, resetEffects]);

  const start = () => {
    const seed = run ? run.seed : randomSeed();
    resetEffects();
    scorePresentation.reset();
    const initial = { st: newState(seed), colors: Array<number>(64).fill(NO_COLOR), lines: 0, gemsCleared: 0 };
    gameRef.current = initial;
    scoreRef.current = { score: 0, moves: 0 };
    comboRef.current = 0;
    accepting.current = !!run;
    setGame(initial);
    setSel(0);
    setGhosts([]);
    setBestCombo(0);
    setBest((b) => ({ ...b, set: false, fresh: false }));
    setFresh(new Set());
    setSweeps([]);
    setMoment(null);
    setFizzle(0);
    setRunId((n) => n + 1);
    setPreview(null);
    setFocusCell(0);
    setAnnounce("");
    setCombo(0);
    setRemaining(DURATION_MS);
    if (run) {
      endsAt.current = run.startedAt + DURATION_MS;
      setPhase("play");
      sfx("go");
      setMoment({ id: -1, text: "Go!", tone: "up", y: 45 });
      later(() => setMoment(m => m?.id === -1 ? null : m), 900);
    } else {
      setPhase("count");
    }
  };

  /** Practice: the clock starts the moment "Go!" shows. */
  const beginPractice = useCallback(() => {
    accepting.current = true;
    endsAt.current = practiceNow() + DURATION_MS;
    setPhase("play");
  }, [practiceNow]);

  // A Match run starts as soon as the chain says `begin_run` landed; Practice counts 3-2-1 as soon as the screen opens.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => {
    if (phase !== "play" || paused) return;
    const t = setInterval(() => {
      const left = endsAt.current - (run ? performance.now() : practiceNow());
      if (left <= 0) {
        setRemaining(0);
        finish("time");
      } else {
        // Keep expiry on the real clock; only redraw the displayed whole second.
        setRemaining(Math.ceil(left / 1000) * 1000);
      }
    }, 100);
    return () => clearInterval(t);
  }, [phase, finish, paused, run, practiceNow]);

  /** Everything a clear does besides the rules: sweep, shards, shake, callout, points to the score, sound. */
  const celebrate = useCallback((lines: number, gems: number, comboNow: number, gained: number, gone: Ghost[], cleared: bigint, id: number) => {
    const board = boardRef.current;
    const sw: Sweep[] = [];
    for (let i = 0; i < SIZE; i++) {
      if ((cleared & (0xffn << BigInt(i * SIZE))) === 0xffn << BigInt(i * SIZE)) sw.push({ id: id * 20 + i, axis: "row", at: i });
      if ((cleared & (0x0101010101010101n << BigInt(i))) === 0x0101010101010101n << BigInt(i)) sw.push({ id: id * 20 + 10 + i, axis: "col", at: i });
    }
    setSweeps((cur) => [...cur, ...sw]);
    later(() => setSweeps((cur) => cur.filter((item) => !sw.includes(item))), CLEAR_MS);

    blockSound(lines, gems, comboNow);
    blockHaptics.play(lines, gems);

    const text = clearCallout(lines, gems, comboNow);
    const row = gone.reduce((n, g) => n + Math.floor(g.i / SIZE) + 0.5, 0) / gone.length;
    setMoment(text ? { id, text, tone: gems > 0 ? "gem" : "plain", y: Math.max(18, Math.min(82, row / SIZE * 100)), combo: comboNow } : null);
    later(() => setMoment(m => m?.id === id ? null : m), 1000);
    const reduced = prefersReducedMotion();
    scorePresentation.award(gained, reduced ? 0 : 780, lines + (gems ? 1 : 0) + 1);
    if (!board || !spaceRef.current || reduced) return;
    const grid = measureGrid(spaceRef.current, board);
    const per = Math.min(4, 1 + lines);
    for (const g of gone) {
      burst({ x: grid.left + (g.i % SIZE) * grid.pitch + grid.cell / 2,
        y: grid.top + Math.floor(g.i / SIZE) * grid.pitch + grid.cell / 2,
        colors: g.gem ? GEM_HEX : [BLOCK_HEX[g.color] ?? "#eaefec", "#ffffff"],
        kind: "shards", count: g.gem ? per + 2 : per, power: 0.45, lifetime: 0.48, size: 3 });
    }
    const kick = Math.min(7, 2.5 + lines + (gems ? 1 : 0));
    animate(visualRef.current ?? board, [
      { transform: "translate(0, 0)" },
      { transform: `translate(${-kick}px, 2px)`, offset: 0.12 },
      { transform: `translate(${kick * 0.6}px, -1px)`, offset: 0.4 },
      { transform: `translate(${-kick * 0.25}px, 0)`, offset: 0.7 },
      { transform: "translate(0, 0)" },
    ], { duration: 190, easing: "ease-out" });

    const sx = grid.left + gone.reduce((n, g) => n + g.i % SIZE, 0) / gone.length * grid.pitch + grid.cell / 2;
    const sy = grid.top + row * grid.pitch;
    const score = scoreEl.current?.getBoundingClientRect();
    if (!score) return;
    const tx = score.left + score.width / 2, ty = score.top + score.height / 2;
    const fly = document.createElement("span");
    fly.textContent = `+${gained}`;
    fly.className = `bp-fly${gems > 0 ? " gem" : ""}`;
    fly.setAttribute("aria-hidden", "true");
    document.body.appendChild(fly);
    const at = (x: number, y: number, scale: number) => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
    animate(fly, [
      { transform: at(sx, sy, .7), opacity: 0 },
      { transform: at(sx, sy - 8, 1.15), opacity: 1, offset: .12 },
      { transform: at(sx, sy - 12, 1), opacity: 1, offset: .46 },
      { transform: at(tx, ty, .45), opacity: 1, offset: .94 },
      { transform: at(tx, ty, .3), opacity: 0 },
    ], { duration: 780, easing: "cubic-bezier(.2,.7,.3,1)" }, () => fly.remove());
  }, [animate, later, scorePresentation]);

  const place = useCallback(
    (idx: number, x: number, y: number) => {
      if (phase !== "play" || paused || !accepting.current) return false;
      const current = gameRef.current;
      let next;
      try {
        next = apply(current.st, { piece: idx, x, y });
      } catch (e) {
        if (e instanceof EngineFailure) return false;
        throw e;
      }
      const piece = pieceAt(current.st.seed, idx);
      const colors = current.colors.slice();
      for (const c of pieceCells(piece)) colors[(y + c.dy) * SIZE + x + c.dx] = colorOf(piece);
      const gone: Ghost[] = [];
      for (let i = 0; i < 64; i++) {
        if ((next.result.cleared >> BigInt(i)) & 1n) {
          gone.push({
            id: popupId.current + 1,
            i,
            color: colors[i],
            gem: ((current.st.gems | footprintGem(piece, x, y)) >> BigInt(i)) & 1n ? true : false,
            delay: Math.round(Math.hypot((i % SIZE) - (x + 0.5), Math.floor(i / SIZE) - (y + 0.5)) * 7),
          });
          colors[i] = NO_COLOR;
        }
      }
      const g: Game = {
        st: next.state,
        colors,
        lines: current.lines + next.result.lines,
        gemsCleared: current.gemsCleared + next.result.gems,
      };
      gameRef.current = g;
      setGame(g);
      scoreRef.current = { score: next.state.score, moves: next.state.moves };
      runRef.current?.onMove({ piece: idx, x, y });
      setPreview(null);
      popupId.current += 1;
      const id = popupId.current;
      const placed = new Set(pieceCells(piece).map((c) => (y + c.dy) * SIZE + x + c.dx));
      setFresh(placed);
      later(() => setFresh((f) => (f === placed ? new Set() : f)), DROP_MS);
      if (gone.length) {
        setGhosts((cur) => [...cur, ...gone]);
        later(() => setGhosts((cur) => cur.filter((ghost) => ghost.id !== id)), CLEAR_MS);
      }
      if (next.result.lines === 0) {
        blockSound(0, 0, 0);
        blockHaptics.play(0, 0);
        scorePresentation.award(next.result.gained, 0, 1);
        if (boardRef.current && spaceRef.current && !prefersReducedMotion()) {
          const grid = measureGrid(spaceRef.current, boardRef.current);
          for (const c of pieceCells(piece)) burst({
            x: grid.left + (x + c.dx + .5) * grid.pitch,
            y: grid.top + (y + c.dy + .5) * grid.pitch,
            colors: [BLOCK_HEX[colorOf(piece)], "#fff"], kind: "shards", count: 2, power: .15, lifetime: .25, size: 2,
          });
        }
        if (comboRef.current > 0) {
          setFizzle(id);
          later(() => setFizzle((f) => (f === id ? 0 : f)), 700);
        }
        comboRef.current = 0;
        setCombo(0);
        setAnnounce(`Placed, plus ${next.result.gained}`);
      } else {
        const newCombo = ++comboRef.current;
        celebrate(next.result.lines, next.result.gems, newCombo, next.result.gained, gone, next.result.cleared, id);
        setCombo(newCombo);
        setBestCombo((b) => Math.max(b, newCombo));
        setAnnounce(`Cleared ${next.result.lines} ${next.result.lines === 1 ? "line" : "lines"}, plus ${next.result.gained}`);
      }
      if (next.state.over) {
        finish(next.state.moves >= MAX_MOVES ? "limit" : "stuck", g);
      } else {
        const nb = handBase(next.state);
        const free = [0, 1, 2].find((n) => ((next.state.used >> n) & 1) === 0) ?? 0;
        setSel(nb + free);
      }
      return true;
    },
    [phase, paused, finish, celebrate, later, scorePresentation, setPreview],
  );

  const reject = useCallback(() => {
    setAnnounce("That piece does not fit there");
    const slot = document.querySelector<HTMLElement>(".bp-slot.sel");
    if (slot && !prefersReducedMotion()) animate(slot, [
      { outline: "2px solid var(--danger)", outlineOffset: "-2px" }, { outline: "2px solid transparent", outlineOffset: "-2px" },
    ], { duration: 180 });
  }, [animate]);
  const { held, gesture: dragMeta, ghost: ghostRef, down: beginDrag, move: moveDrag, up: endDrag, cancel: onTrayCancel } = usePieceDrag({ space: spaceRef, board: boardRef, preview: setPreview, place, reject });
  useEffect(() => { if (phase !== "play" || paused) onTrayCancel(); }, [phase, paused, onTrayCancel]);
  const onTrayDown = (e: React.PointerEvent<HTMLButtonElement>, idx: number) => {
    if (paused || phase !== "play" || (st.used >> (idx - base)) & 1) return;
    if (beginDrag(e, idx, pieceAt(st.seed, idx))) setSel(idx);
  };

  const hover = (cx: number, cy: number) => {
    if (!selPiece || dragMeta.current) return;
    setPreview(anchorFor(selPiece, cx, cy));
  };

  const onCellKey = (e: React.KeyboardEvent, cx: number, cy: number) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    const nx = Math.min(Math.max(cx + v[0], 0), SIZE - 1);
    const ny = Math.min(Math.max(cy + v[1], 0), SIZE - 1);
    setFocusCell(ny * SIZE + nx);
    hover(nx, ny);
    boardRef.current?.querySelectorAll<HTMLButtonElement>("button")[ny * SIZE + nx]?.focus();
  };

  const timeLow = remaining <= 10_000;
  const secondsLeft = Math.ceil(remaining / 1000);
  useEffect(() => {
    if (phase === "play" && timeLow && secondsLeft > 0) sfx("tick");
  }, [phase, timeLow, secondsLeft]);



  const board = (
    <div
      className={`bp-board${phase === "play" ? " live" : ""}${timeLow && phase === "play" ? " low" : ""}`}
      ref={boardRef}
      role="grid"
      aria-label="Block Burst board, 8 by 8"
      onPointerLeave={() => !dragMeta.current && setPreview(null)}
    >
      {Array.from({ length: 64 }, (_, i) => {
        const cx = i % SIZE;
        const cy = Math.floor(i / SIZE);
        const filled = (st.occ >> BigInt(i)) & 1n;
        const isGem = (st.gems >> BigInt(i)) & 1n;
        const color = game.colors[i];
        const cls = ["bp-cell"];
        if (filled) cls.push(`k${color}`, "on");
        if (filled && fresh.has(i)) cls.push("drop");
        if (filled && isGem) cls.push("gem");
        return (
          <button
            key={i}
            type="button"
            role="gridcell"
            className={cls.join(" ")}
            tabIndex={i === focusCell ? 0 : -1}
            aria-label={`Row ${cy + 1}, column ${cx + 1}${filled ? (isGem ? ", gem block" : ", filled") : ""}`}
            disabled={phase !== "play" || paused}
            onPointerEnter={(e) => e.pointerType === "mouse" && hover(cx, cy)}
            onFocus={() => setFocusCell(i)}
            onKeyDown={(e) => onCellKey(e, cx, cy)}
            onClick={() => {
              if (!selPiece) return;
              const a = anchorFor(selPiece, cx, cy);
              if (!place(sel, a.x, a.y)) reject();
            }}
          />
        );
      })}
    </div>
  );

  return (
    <Arena game="block-puzzle" autoFull={phase !== "over"}>
    <div className="bpx">
      <div className="bpx-hud">
        <div className="bpx-score">
          <span className="cut bpx-face" aria-hidden="true">
            {me ? <PlayerAvatar account={me} size={44} /> : null}
          </span>
          <span ref={scoreEl} className="bp-score-n tnum" hidden={phase === "over"} aria-label="Score" aria-live="off"><span ref={scoreAura} className="bp-score-aura" aria-hidden="true" /><CountUp key={runId} value={scoreReceipt.total} from={0} format={String} duration={180} /></span>
        </div>
      <header className="cut cut-card bpx-bar" aria-label={run ? "Match" : "Practice"}>
        <div className={`bpx-ring${timeLow && phase === "play" ? " low" : ""}`} role="timer" aria-label="Time left">
          <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
            <circle cx="60" cy="60" r={RING_R} className="bpx-ring-bg" />
            <circle
              cx="60"
              cy="60"
              r={RING_R}
              className="bpx-ring-fg"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - Math.max(0, Math.min(1, (phase === "idle" || phase === "count" ? DURATION_MS : remaining) / DURATION_MS)))}
              transform="rotate(-90 60 60)"
            />
          </svg>
          <span className="mono">{fmtClock(phase === "idle" || phase === "count" ? DURATION_MS : remaining)}</span>
        </div>
        <div className="bpx-stake">
          {run ? (
            <span className="bpx-pot" aria-label={`Pot ${fmtN(run.entry * 2)} Gemas, entry ${fmtN(run.entry)}`}>
              <small>Pot</small>
              <b className="tnum">
                <GemaMark size={16} /> {fmtN(run.entry * 2)}
              </b>
            </span>
          ) : (
            <span className="cut cut-chip game-tag">Practice</span>
          )}
          {!run && <PracticePauseButton paused={paused} onToggle={() => { onTrayCancel(); togglePause(); }} disabled={phase !== "play"} />}
          <GameMenu items={gameItems} leaveHref={run ? undefined : "/play"} />
        </div>
      </header>
      </div>

      <section className="bpx-mid" aria-label="Board">
        <h1 className="sr-only">Block Burst</h1>
      <div className="bp-stage">
        <div className={`bp-board-space${timeLow && phase === "play" ? " low" : ""}`} ref={spaceRef}>
          <div className="bp-board-visual" ref={visualRef}>
          {board}
          <div className="bp-clear-grid" aria-hidden="true">
            {ghosts.filter((g) => !((st.occ >> BigInt(g.i)) & 1n)).map((g) => (
              <i key={`${g.id}:${g.i}`} className={`bp-cell pop k${g.color}${g.gem ? " gem" : ""}`} style={{ gridColumn: g.i % SIZE + 1, gridRow: Math.floor(g.i / SIZE) + 1, animationDelay: `${g.delay}ms` }} />
            ))}
          </div>
          {sweeps.map((w) => (
            <span key={w.id} className={`bp-sweep ${w.axis}`} style={{ "--at": w.at } as React.CSSProperties} aria-hidden="true" />
          ))}
          </div>
        </div>
        {paused && <PracticePauseOverlay onResume={togglePause} items={gameItems} leaveHref="/play" />}
        {(phase === "count" || goOn) && (
          <Countdown
            from={3}
            onDone={() => {
              setGoOn(true);
              beginPractice();
            }}
            onEnd={() => setGoOn(false)}
          />
        )}
        {phase === "over" && (
          <div className="bp-overlay" role="dialog" aria-label="Game over">
            <div className="stack bp-over">
              <Label>{reason === "time" ? "Time's up" : reason === "limit" ? "Move limit reached" : "No piece fits"}</Label>
              <span className="bp-final tnum"><CountUp value={st.score} from={0} format={String} duration={900} /></span>
              {!run && (
                <span className={`bp-best${best.fresh ? " new" : ""}`}>{best.fresh ? "New best!" : `Best ${best.value}`}</span>
              )}
              <ul className="bp-stats" aria-label="Run stats">
                {[
                  ["Moves", st.moves],
                  ["Lines", game.lines],
                  ["Gems cleared", game.gemsCleared],
                  ["Best combo", bestCombo],
                ].map(([k, v], n) => (
                  <li key={k} className="cut" style={{ animationDelay: `${500 + n * 110}ms` }}>
                    <b className="tnum">{v}</b>
                    <span>{k}</span>
                  </li>
                ))}
              </ul>
              {run ? (
                <p className="note">Sending…</p>
              ) : (
                <>
                  <div className="bp-actions">
                    <Button onClick={start}>Play again</Button>
                    <Button href="/play">Back to games</Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {moment && <div key={moment.id} className={`bp-moment ${moment.tone}`} style={{ top: `${moment.y}%` }} aria-hidden="true">
          <strong>{moment.text}</strong>
          {(moment.combo ?? 0) >= 2 && !moment.text.startsWith("Combo") && <small>Combo ×{moment.combo}</small>}
        </div>}
      </div>

      <div className="bp-tray" aria-label="Pieces">
        {[0, 1, 2].map((n) => {
          const idx = base + n;
          const used = phase === "idle" ? false : ((st.used >> n) & 1) === 1;
          const piece = hand[n];
          const isSel = phase === "play" && !used && sel === idx;
          const stuck = phase === "play" && !used && !available[n];
          return (
            <button
              key={n}
              type="button"
              className={`cut cut-btn bp-slot${isSel ? " sel" : ""}${used ? " used" : ""}${stuck ? " stuck" : ""}${held?.idx === idx ? " held" : ""}`}
              disabled={phase !== "play" || paused || used}
              aria-pressed={isSel}
              aria-label={`Piece ${n + 1}${piece.gem !== null ? ", has a gem" : ""}${stuck ? ", does not fit" : ""}`}
              onPointerDown={(e) => onTrayDown(e, idx)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={onTrayCancel}
              onLostPointerCapture={() => { if (dragMeta.current) onTrayCancel(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!used && phase === "play") {
                    setSel(idx);
                    boardRef.current?.querySelectorAll<HTMLButtonElement>("button")[focusCell]?.focus();
                  }
                }
              }}
            >
              {!used && phase !== "over" && (
                <span key={base} className="bp-deal">
                  <PieceArt piece={piece} cell={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="bpx-run" aria-label="Run">
        <span className={`cut cut-chip bpx-combo${fizzle ? " fizzle" : ""}`} data-heat={comboHeat(combo)} aria-label={`Combo ${combo}`}>
          <Zap aria-hidden="true" />
          <b className="tnum">×{combo}</b>
        </span>
        <span className="cut cut-chip bpx-lines" aria-label={`Lines ${game.lines}`}>
          <Rows3 aria-hidden="true" />
          <b className="tnum">{game.lines}</b>
        </span>
      </div>
      </section>

      {matchPanel && <div className="bpx-foot">{matchPanel}</div>}

      {held && (
        <div ref={ghostRef} className="bp-ghost" style={{ transform: `translate3d(${held.px}px, ${held.py}px, 0)` }} aria-hidden="true">
          <div className="bp-pickup" style={{ "--pickup-x": `${held.pickupX}px`, "--pickup-y": `${held.pickupY}px`, "--pickup-scale": held.scale } as React.CSSProperties}>
            <PieceArt piece={held.piece} cell={held.grid.cell} gap={held.grid.gap} />
          </div>
        </div>
      )}
      {checkingVibration && <VibrationCheck onClose={() => {
        setCheckingVibration(false);
        if (resumeAfterCheck.current) togglePause();
        resumeAfterCheck.current = false;
        document.querySelector<HTMLButtonElement>('button[aria-label="Game menu"]')?.focus();
      }} />}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    </div>
    </Arena>
  );
}

function footprintGem(piece: Piece, x: number, y: number): bigint {
  const c = pieceCells(piece).find((k) => k.gem);
  return c ? 1n << BigInt((y + c.dy) * SIZE + x + c.dx) : 0n;
}
