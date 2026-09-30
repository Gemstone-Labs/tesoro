"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGuideHidden } from "@/components/guide/Guide";
import { Button, Label } from "@/components/ui";
import { apply, EngineFailure, MAX_MOVES, SIZE, dims, fitsAt, handBase, newState, pieceAt, pieceCells } from "./engine";
import type { Piece, State } from "./engine";
import "./block-puzzle.css";

const DURATION_MS = 90_000;
const CLEAR_MS = 320;
const NO_COLOR = 255;
const LIFT_TOUCH_PX = 64;

type Phase = "idle" | "play" | "over";
type Reason = "time" | "stuck" | "limit";

interface Ghost {
  i: number;
  color: number;
  gem: boolean;
}
interface Popup {
  id: number;
  text: string;
  gem: boolean;
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

function PieceArt({ piece, cell }: { piece: Piece; cell: number }) {
  const [w, h] = dims(piece);
  return (
    <span
      className="bp-mini"
      style={{ gridTemplateColumns: `repeat(${w}, ${cell}px)`, gridTemplateRows: `repeat(${h}, ${cell}px)` }}
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

interface Clear {
  id: number;
  lines: number;
  gained: number;
  /** Clock time left (ms) when it happened; "ago" is this minus the clock now. */
  at: number;
}

const fmtN = (n: number) => n.toLocaleString("en-US");
const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The Block Puzzle play screen: MATCH panel left, score + 90 s ring + board + tray centre, combo,
 * lines and recent clears right. No character anywhere on it. `matchPanel` is the Match status the
 * caller owns (who we wait for); without a `run` this is practice.
 */
export function BlockPuzzleGame({ run, matchPanel }: { run?: MatchRun; matchPanel?: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [combo, setCombo] = useState(0);
  const [recent, setRecent] = useState<Clear[]>([]);
  useGuideHidden(phase === "play");
  const [reason, setReason] = useState<Reason>("time");
  const [game, setGame] = useState<Game>(() => ({ st: newState(0n), colors: [], lines: 0, gemsCleared: 0 }));
  const [sel, setSel] = useState(0);
  const [remaining, setRemaining] = useState(DURATION_MS);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ idx: number; px: number; py: number; cell: number } | null>(null);
  const [focusCell, setFocusCell] = useState(0);
  const [announce, setAnnounce] = useState("");

  const endsAt = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragMeta = useRef<{ idx: number; sx: number; sy: number; moved: boolean; lift: number; cell: number } | null>(null);
  const popupId = useRef(0);

  const { st } = game;
  const base = handBase(st);
  const hand = useMemo(() => [0, 1, 2].map((n) => pieceAt(st.seed, base + n)), [st.seed, base]);
  const selPiece = phase === "play" && (st.used >> (sel - base)) & 1 ? null : hand[sel - base] ?? null;

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const scoreRef = useRef({ score: 0, moves: 0 });
  const finish = useCallback((why: Reason, final?: Game) => {
    const st = final?.st;
    runRef.current?.onEnd({ score: st?.score ?? scoreRef.current.score, moves: st?.moves ?? scoreRef.current.moves, reason: why });
    setPhase("over");
    setReason(why);
    setPreview(null);
    setDrag(null);
    dragMeta.current = null;
    if (final) setGame(final);
  }, []);

  const start = () => {
    const seed = run ? run.seed : randomSeed();
    setGame({ st: newState(seed), colors: Array<number>(64).fill(NO_COLOR), lines: 0, gemsCleared: 0 });
    setSel(0);
    setGhosts([]);
    setPopup(null);
    setPreview(null);
    setFocusCell(0);
    setAnnounce("");
    setCombo(0);
    setRecent([]);
    setRemaining(DURATION_MS);
    endsAt.current = (run ? run.startedAt : performance.now()) + DURATION_MS;
    setPhase("play");
  };

  // A Match run starts as soon as the chain says `begin_run` landed.
  const started = useRef(false);
  useEffect(() => {
    if (run && !started.current) {
      started.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => {
    if (phase !== "play") return;
    const t = setInterval(() => {
      const left = endsAt.current - performance.now();
      if (left <= 0) {
        setRemaining(0);
        finish("time");
      } else {
        setRemaining(left);
      }
    }, 100);
    return () => clearInterval(t);
  }, [phase, finish]);

  const place = useCallback(
    (idx: number, x: number, y: number) => {
      if (phase !== "play") return false;
      let next;
      try {
        next = apply(game.st, { piece: idx, x, y });
      } catch (e) {
        if (e instanceof EngineFailure) return false;
        throw e;
      }
      const piece = pieceAt(game.st.seed, idx);
      const colors = game.colors.slice();
      for (const c of pieceCells(piece)) colors[(y + c.dy) * SIZE + x + c.dx] = colorOf(piece);
      const gone: Ghost[] = [];
      for (let i = 0; i < 64; i++) {
        if ((next.result.cleared >> BigInt(i)) & 1n) {
          gone.push({ i, color: colors[i], gem: ((game.st.gems | footprintGem(piece, x, y)) >> BigInt(i)) & 1n ? true : false });
          colors[i] = NO_COLOR;
        }
      }
      const g: Game = {
        st: next.state,
        colors,
        lines: game.lines + next.result.lines,
        gemsCleared: game.gemsCleared + next.result.gems,
      };
      setGame(g);
      scoreRef.current = { score: next.state.score, moves: next.state.moves };
      runRef.current?.onMove({ piece: idx, x, y });
      setPreview(null);
      if (gone.length) {
        setGhosts(gone);
        setTimeout(() => setGhosts([]), CLEAR_MS);
      }
      if (next.result.lines > 0) {
        popupId.current += 1;
        setCombo((c) => c + 1);
        setRecent((r) => [{ id: popupId.current, lines: next.result.lines, gained: next.result.gained, at: endsAt.current - performance.now() }, ...r].slice(0, 3));
        const gem = next.result.gems > 0;
        setPopup({ id: popupId.current, text: `+${next.result.gained}${gem ? ` · gem x${1 + next.result.gems}` : ""}`, gem });
        setAnnounce(`Cleared ${next.result.lines} ${next.result.lines === 1 ? "line" : "lines"}, plus ${next.result.gained}`);
      } else {
        setCombo(0);
        setAnnounce(`Placed, plus ${next.result.gained}`);
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
    [phase, game, finish],
  );

  const cellFromPoint = (px: number, py: number) => {
    const r = boardRef.current?.getBoundingClientRect();
    if (!r) return null;
    const cell = r.width / SIZE;
    const cx = Math.floor((px - r.left) / cell);
    const cy = Math.floor((py - r.top) / cell);
    if (cx < -1 || cy < -1 || cx > SIZE || cy > SIZE) return null;
    return { cx: Math.min(Math.max(cx, 0), SIZE - 1), cy: Math.min(Math.max(cy, 0), SIZE - 1), cell };
  };

  const onTrayDown = (e: React.PointerEvent<HTMLButtonElement>, idx: number) => {
    if (phase !== "play" || (st.used >> (idx - base)) & 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const cell = (boardRef.current?.getBoundingClientRect().width ?? 320) / SIZE;
    dragMeta.current = { idx, sx: e.clientX, sy: e.clientY, moved: false, lift: e.pointerType === "touch" ? LIFT_TOUCH_PX : 0, cell };
    setSel(idx);
  };

  const onTrayMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const m = dragMeta.current;
    if (!m) return;
    if (!m.moved && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) < 8) return;
    m.moved = true;
    setDrag({ idx: m.idx, px: e.clientX, py: e.clientY - m.lift, cell: m.cell });
    const hit = cellFromPoint(e.clientX, e.clientY - m.lift);
    const piece = pieceAt(st.seed, m.idx);
    setPreview(hit ? anchorFor(piece, hit.cx, hit.cy) : null);
  };

  const onTrayUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const m = dragMeta.current;
    dragMeta.current = null;
    setDrag(null);
    if (!m || !m.moved) return;
    const hit = cellFromPoint(e.clientX, e.clientY - m.lift);
    setPreview(null);
    if (hit) {
      const a = anchorFor(pieceAt(st.seed, m.idx), hit.cx, hit.cy);
      place(m.idx, a.x, a.y);
    }
  };

  const onTrayCancel = () => {
    dragMeta.current = null;
    setDrag(null);
    setPreview(null);
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

  const previewInfo = useMemo(() => {
    if (!preview || !selPiece) return null;
    const cells = new Set(pieceCells(selPiece).map((c) => (preview.y + c.dy) * SIZE + preview.x + c.dx));
    return { cells, valid: fitsAt(st, selPiece, preview.x, preview.y) };
  }, [preview, selPiece, st]);

  const ghostAt = useMemo(() => new Map(ghosts.map((g) => [g.i, g])), [ghosts]);
  const timeLow = remaining <= 10_000;

  const board = (
    <div
      className={`bp-board${phase === "play" ? " live" : ""}`}
      ref={boardRef}
      role="grid"
      aria-label="Block Puzzle board, 8 by 8"
      onPointerLeave={() => !dragMeta.current && setPreview(null)}
    >
      {Array.from({ length: 64 }, (_, i) => {
        const cx = i % SIZE;
        const cy = Math.floor(i / SIZE);
        const filled = (st.occ >> BigInt(i)) & 1n;
        const isGem = (st.gems >> BigInt(i)) & 1n;
        const color = game.colors[i];
        const gh = ghostAt.get(i);
        const pv = previewInfo?.cells.has(i);
        const cls = ["bp-cell"];
        if (filled) cls.push(`k${color}`, "on");
        if (filled && isGem) cls.push("gem");
        if (gh) cls.push(`k${gh.color}`, "pop", ...(gh.gem ? ["gem"] : []));
        if (pv) cls.push(previewInfo?.valid ? "pv" : "pv bad");
        return (
          <button
            key={i}
            type="button"
            role="gridcell"
            className={cls.join(" ")}
            tabIndex={i === focusCell ? 0 : -1}
            aria-label={`Row ${cy + 1}, column ${cx + 1}${filled ? (isGem ? ", gem block" : ", filled") : ""}`}
            disabled={phase !== "play"}
            onPointerEnter={(e) => e.pointerType === "mouse" && hover(cx, cy)}
            onFocus={() => setFocusCell(i)}
            onKeyDown={(e) => onCellKey(e, cx, cy)}
            onClick={() => {
              if (!selPiece) return;
              const a = anchorFor(selPiece, cx, cy);
              if (!place(sel, a.x, a.y)) setAnnounce("That piece does not fit there");
            }}
          />
        );
      })}
      {popup && (
        <span key={popup.id} className={`bp-popup${popup.gem ? " gem" : ""}`} aria-hidden="true">
          {popup.text}
        </span>
      )}
    </div>
  );

  return (
    <div className="bpx">
      <aside className="cut cut-frame bpx-panel bpx-left" aria-label={run ? "Match" : "Practice"}>
        <h2 className="h-section">{run ? "Match" : "Practice"}</h2>
        {run ? (
          <>
            <div className="bpx-kv">
              <span>Entry</span>
              <b>{fmtN(run.entry)} <small>Gemas</small></b>
            </div>
            <div className="bpx-kv">
              <span>Pot</span>
              <b>{fmtN(run.entry * 2)} <small>Gemas</small></b>
            </div>
          </>
        ) : (
          <p className="bpx-status">No Gemas are staked in practice. Same rules, a random Seed.</p>
        )}
        {matchPanel}
        <span className="mono bpx-seed" title="Seed">
          {phase === "idle" ? "Seed —" : `Seed 0x${st.seed.toString(16).padStart(16, "0").slice(0, 6)}…`}
        </span>
      </aside>

      <section className="cut cut-frame bpx-panel bpx-mid" aria-label="Board">
        <h1 className="bpx-title h-section">Block Puzzle</h1>
        <div className="bpx-head">
          <div className="bpx-score">
            <Label>Score</Label>
            <span className="bp-score-n tnum" aria-live="off">{st.score}</span>
          </div>
          <div className="bpx-timer">
            <div className={`bpx-ring${timeLow && phase === "play" ? " low" : ""}`} role="timer" aria-label="Time left">
              <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
                <circle cx="60" cy="60" r={RING_R} className="bpx-ring-bg" />
                <circle
                  cx="60"
                  cy="60"
                  r={RING_R}
                  className="bpx-ring-fg"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - Math.max(0, Math.min(1, (phase === "idle" ? DURATION_MS : remaining) / DURATION_MS)))}
                  transform="rotate(-90 60 60)"
                />
              </svg>
              <span className="mono">{fmtClock(phase === "idle" ? DURATION_MS : remaining)}</span>
            </div>
            <span className="bpx-secs">90 seconds</span>
          </div>
        </div>

      <div className="bp-stage">
        {board}
        {phase === "idle" && !run && (
          <div className="bp-overlay">
            <div className="stack" style={{ justifyItems: "center", textAlign: "center" }}>
              <h2 className="bp-title">Block Puzzle</h2>
              <p className="meta">
                Place pieces, clear full rows and columns. Clearing a gem block multiplies that clear. 90 seconds.
              </p>
              <Button onClick={start}>Start practice</Button>
            </div>
          </div>
        )}
        {phase === "over" && (
          <div className="bp-overlay" role="dialog" aria-label="Game over">
            <div className="stack" style={{ justifyItems: "center", textAlign: "center" }}>
              <Label>{reason === "time" ? "Time's up" : reason === "limit" ? "Move limit reached" : "No piece fits"}</Label>
              <span className="bp-final tnum">{st.score}</span>
              <p className="meta tnum">
                {st.moves} moves · {game.lines} lines · {game.gemsCleared} gems cleared
              </p>
              {run ? (
                <p className="note">Run over. Sending it to the chain…</p>
              ) : (
                <>
                  <p className="note">Practice: nothing was staked and no Gemas moved.</p>
                  <div className="bp-actions">
                    <Button onClick={start}>Play again</Button>
                    <Button href="/">Lobby</Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="bp-tray" aria-label="Pieces">
        {[0, 1, 2].map((n) => {
          const idx = base + n;
          const used = phase === "idle" ? false : ((st.used >> n) & 1) === 1;
          const piece = hand[n];
          const isSel = phase === "play" && !used && sel === idx;
          const stuck = phase === "play" && !used && ![...Array(64).keys()].some((i) => fitsAt(st, piece, i % SIZE, Math.floor(i / SIZE)));
          return (
            <button
              key={n}
              type="button"
              className={`bp-slot${isSel ? " sel" : ""}${used ? " used" : ""}${stuck ? " stuck" : ""}`}
              disabled={phase !== "play" || used}
              aria-pressed={isSel}
              aria-label={`Piece ${n + 1}${piece.gem !== null ? ", has a gem" : ""}${stuck ? ", does not fit" : ""}`}
              onPointerDown={(e) => onTrayDown(e, idx)}
              onPointerMove={onTrayMove}
              onPointerUp={onTrayUp}
              onPointerCancel={onTrayCancel}
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
              {!used && phase !== "over" && <PieceArt piece={piece} cell={16} />}
            </button>
          );
        })}
      </div>
      <p className="note bp-help">Drag a piece onto the board, or tap a piece then a cell.</p>
      </section>

      <aside className="cut cut-frame bpx-panel bpx-right" aria-label="Run">
        <div className="bpx-combo">
          <span className="h-section">Combo</span>
          <b className="h-section tnum">×{combo}</b>
        </div>
        <div className="bpx-lines">
          <span>Lines cleared</span>
          <b className="tnum">{game.lines}</b>
        </div>
        <div className="bpx-recent">
          <h2 className="h-section">Recent</h2>
          {recent.length === 0 && <p className="meta">Clear a full row or column to see it here.</p>}
          {recent.map((c) => (
            <div key={c.id} className="cut cut-card bpx-clear">
              <span>
                <b>{c.lines} {c.lines === 1 ? "line" : "lines"} cleared</b>
                <small>{Math.max(0, Math.round((c.at - remaining) / 1000))}s ago</small>
              </span>
              <b className="tnum">+{c.gained}</b>
            </div>
          ))}
        </div>
      </aside>

      {drag && (
        <div className="bp-ghost" style={{ transform: `translate(${drag.px}px, ${drag.py}px) translate(-50%, -50%)` }} aria-hidden="true">
          <PieceArt piece={pieceAt(st.seed, drag.idx)} cell={drag.cell} />
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    </div>
  );
}

function footprintGem(piece: Piece, x: number, y: number): bigint {
  const c = pieceCells(piece).find((k) => k.gem);
  return c ? 1n << BigInt((y + c.dy) * SIZE + x + c.dx) : 0n;
}
