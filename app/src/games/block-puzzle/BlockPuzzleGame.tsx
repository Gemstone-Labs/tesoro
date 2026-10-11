"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGuideHidden } from "@/components/guide/Guide";
import { Button, CountUp, Label } from "@/components/ui";
import { apply, EngineFailure, MAX_MOVES, SIZE, dims, fitsAt, handBase, newState, pieceAt, pieceCells } from "./engine";
import type { Piece, State } from "./engine";
import { Arena, Callout, MuteToggle, burstAt, prefersReducedMotion, sfx, shake } from "../fx";
import type { CalloutTone } from "../fx";
import { clearCallout, comboHeat, wouldClear } from "./feel";
import "./block-puzzle.css";

const DURATION_MS = 90_000;
const CLEAR_MS = 760;
const DROP_MS = 420;
const BLOCK_HEX = ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"];
const GEM_HEX = ["#6af8d6", "#24d8a8", "#c8fff0"];
const NO_COLOR = 255;
const LIFT_TOUCH_PX = 64;

type Phase = "idle" | "play" | "over";
type Reason = "time" | "stuck" | "limit";

interface Ghost {
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
 * The Block Puzzle play screen: a slim bar (score, 90 s ring, combo and lines, entry and pot) over the
 * centred board and tray; recent clears show on the game-over card. No character anywhere on it. `matchPanel` is the Match status the
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
  const [bestCombo, setBestCombo] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [fizzle, setFizzle] = useState(0);
  const [runId, setRunId] = useState(0);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ idx: number; px: number; py: number; cell: number } | null>(null);
  const [focusCell, setFocusCell] = useState(0);
  const [announce, setAnnounce] = useState("");

  const endsAt = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragMeta = useRef<{ idx: number; sx: number; sy: number; moved: boolean; lift: number; cell: number } | null>(null);
  const popupId = useRef(0);
  const scoreEl = useRef<HTMLSpanElement>(null);

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
    setBestCombo(0);
    setFresh(new Set());
    setSweeps([]);
    setMoment(null);
    setFizzle(0);
    setRunId((n) => n + 1);
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

  /** Everything a clear does besides the rules: sweep, shards, shake, callout, points to the score, sound. */
  const celebrate = useCallback((lines: number, gems: number, comboNow: number, gained: number, gone: Ghost[], cleared: bigint, id: number) => {
    const board = boardRef.current;
    const sw: Sweep[] = [];
    for (let i = 0; i < SIZE; i++) {
      if ((cleared & (0xffn << BigInt(i * SIZE))) === 0xffn << BigInt(i * SIZE)) sw.push({ id: id * 20 + i, axis: "row", at: i });
      if ((cleared & (0x0101010101010101n << BigInt(i))) === 0x0101010101010101n << BigInt(i)) sw.push({ id: id * 20 + 10 + i, axis: "col", at: i });
    }
    setSweeps(sw);
    setTimeout(() => setSweeps((cur) => (cur === sw ? [] : cur)), 700);

    sfx(gems > 0 ? "gem" : "clear");
    if (comboNow >= 2) setTimeout(() => sfx("combo"), 110);

    const text = clearCallout(lines, gems, comboNow);
    if (text) setMoment({ id, text, tone: gems > 0 ? "gem" : "plain" });

    if (!board || prefersReducedMotion()) return;
    const cells = board.querySelectorAll<HTMLElement>("button");
    const per = Math.min(5, 2 + lines);
    for (const g of gone) {
      const el = cells[g.i];
      if (!el) continue;
      setTimeout(() => burstAt(el, { colors: g.gem ? GEM_HEX : [BLOCK_HEX[g.color] ?? "#eaefec", "#ffffff"], kind: "shards", count: g.gem ? per + 4 : per }), g.delay);
    }
    shake(board, Math.min(1, 0.18 + lines * 0.22 + (gems > 0 ? 0.15 : 0)));

    const to = scoreEl.current?.getBoundingClientRect();
    const from = board.getBoundingClientRect();
    if (to && typeof document !== "undefined") {
      const fly = document.createElement("span");
      fly.textContent = `+${gained}`;
      fly.className = `bp-fly${gems > 0 ? " gem" : ""}`;
      fly.setAttribute("aria-hidden", "true");
      document.body.appendChild(fly);
      const sx = from.left + from.width / 2;
      const sy = from.top + from.height / 2;
      const dx = to.left + to.width / 2 - sx;
      const dy = to.top + to.height / 2 - sy;
      const anim = fly.animate(
        [
          { transform: `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(0.6)`, opacity: 0 },
          { transform: `translate(${sx}px, ${sy - 18}px) translate(-50%, -50%) scale(1.25)`, opacity: 1, offset: 0.28 },
          { transform: `translate(${sx + dx}px, ${sy + dy}px) translate(-50%, -50%) scale(0.7)`, opacity: 0.2 },
        ],
        { duration: 780, easing: "cubic-bezier(0.5, 0, 0.2, 1)" },
      );
      anim.onfinish = () => fly.remove();
      anim.oncancel = () => fly.remove();
    }
  }, []);

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
          gone.push({
            i,
            color: colors[i],
            gem: ((game.st.gems | footprintGem(piece, x, y)) >> BigInt(i)) & 1n ? true : false,
            delay: Math.round(Math.hypot((i % SIZE) - (x + 0.5), Math.floor(i / SIZE) - (y + 0.5)) * 28),
          });
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
      popupId.current += 1;
      const id = popupId.current;
      const placed = new Set(pieceCells(piece).map((c) => (y + c.dy) * SIZE + x + c.dx));
      setFresh(placed);
      setTimeout(() => setFresh((f) => (f === placed ? new Set() : f)), DROP_MS);
      if (gone.length) {
        setGhosts(gone);
        setTimeout(() => setGhosts((cur) => (cur === gone ? [] : cur)), CLEAR_MS);
      }
      if (next.result.lines === 0) {
        sfx("check");
        if (combo > 0) {
          setFizzle(id);
          setTimeout(() => setFizzle((f) => (f === id ? 0 : f)), 700);
        }
        setCombo(0);
        setAnnounce(`Placed, plus ${next.result.gained}`);
      } else {
        const newCombo = combo + 1;
        celebrate(next.result.lines, next.result.gems, newCombo, next.result.gained, gone, next.result.cleared, id);
        setCombo(newCombo);
        setBestCombo((b) => Math.max(b, newCombo));
        setRecent((r) => [{ id, lines: next.result.lines, gained: next.result.gained, at: endsAt.current - performance.now() }, ...r].slice(0, 3));
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
    [phase, game, finish, combo, celebrate],
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
    return { cells, valid: fitsAt(st, selPiece, preview.x, preview.y), color: colorOf(selPiece) };
  }, [preview, selPiece, st]);

  const hint = useMemo(
    () => (preview && selPiece && previewInfo?.valid ? wouldClear(st, selPiece, preview.x, preview.y) : null),
    [preview, selPiece, previewInfo, st],
  );
  const hinting = hint !== null && hint.rows.length + hint.cols.length > 0;

  const prevScore = useRef(0);
  useEffect(() => {
    const el = scoreEl.current;
    if (el && st.score > prevScore.current && typeof el.animate === "function" && !prefersReducedMotion()) {
      el.animate(
        [
          { transform: "scale(1.28)", color: "#fff", textShadow: "0 0 18px rgba(234,239,236,0.6)" },
          { transform: "scale(1)" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 1.6, 0.4, 1)" },
      );
    }
    prevScore.current = st.score;
  }, [st.score]);

  const ghostAt = useMemo(() => new Map(ghosts.map((g) => [g.i, g])), [ghosts]);
  const timeLow = remaining <= 10_000;

  const board = (
    <div
      className={`bp-board${phase === "play" ? " live" : ""}${timeLow && phase === "play" ? " low" : ""}`}
      style={hinting && previewInfo ? ({ "--hk": BLOCK_HEX[previewInfo.color] } as React.CSSProperties) : undefined}
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
        if (filled && fresh.has(i)) cls.push("drop");
        if (hinting && (hint.rows.includes(cy) || hint.cols.includes(cx))) cls.push("hint");
        if (filled && isGem) cls.push("gem");
        if (gh) cls.push(`k${gh.color}`, "pop", ...(gh.gem ? ["gem"] : []));
        if (pv) cls.push(previewInfo?.valid ? `pv pk${previewInfo.color}` : "pv bad");
        return (
          <button
            key={i}
            type="button"
            role="gridcell"
            className={cls.join(" ")}
            style={gh ? ({ animationDelay: `${gh.delay}ms` } as React.CSSProperties) : undefined}
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
    </div>
  );

  return (
    <Arena game="block-puzzle">
    <div className="bpx">
      <header className="cut cut-card bpx-bar" aria-label={run ? "Match" : "Practice"}>
        <div className="bpx-score">
          <Label>Score</Label>
          <span ref={scoreEl} className="bp-score-n tnum" aria-live="off"><CountUp key={runId} value={st.score} from={0} format={String} duration={500} /></span>
        </div>
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
        <div className="bpx-run" aria-label="Run">
          <span className={`bpx-combo${fizzle ? " fizzle" : ""}`} data-heat={comboHeat(combo)} aria-label={`Combo ${combo}`}>
            <span className="bpx-combo-l">Combo</span>
            <i className="bpx-combo-m" aria-hidden="true"><s /><s /><s /><s /></i>
            <b className="tnum">×{combo}</b>
          </span>
          <span>Lines <b className="tnum">{game.lines}</b></span>
        </div>
        <div className="bpx-stake">
          {run ? (
            <span>Entry <b className="tnum">{fmtN(run.entry)}</b> · Pot <b className="tnum">{fmtN(run.entry * 2)}</b></span>
          ) : (
            <span>Practice · nothing staked</span>
          )}
          <MuteToggle />
        </div>
      </header>

      <section className="bpx-mid" aria-label="Board">
        <h1 className="sr-only">Block Puzzle</h1>
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
              {recent.length > 0 && (
                <ul className="bpx-clears" aria-label="Recent clears">
                  {recent.slice(0, 3).map((c) => (
                    <li key={c.id}>
                      {c.lines} {c.lines === 1 ? "line" : "lines"} cleared <b className="tnum">+{c.gained}</b>
                    </li>
                  ))}
                </ul>
              )}
              {run ? (
                <p className="note">Run over. Sending it to the chain…</p>
              ) : (
                <>
                  <p className="note">Practice: nothing was staked and no Gemas moved.</p>
                  <div className="bp-actions">
                    <Button onClick={start}>Play again</Button>
                    <Button href="/lobby">Lobby</Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {sweeps.map((w) => (
          <span key={w.id} className={`bp-sweep ${w.axis}`} style={{ "--at": w.at } as React.CSSProperties} aria-hidden="true" />
        ))}
        {moment && <Callout key={moment.id} text={moment.text} tone={moment.tone} onDone={() => setMoment((m) => (m?.id === moment.id ? null : m))} />}
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
              className={`cut cut-btn bp-slot${isSel ? " sel" : ""}${used ? " used" : ""}${stuck ? " stuck" : ""}`}
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
              {!used && phase !== "over" && (
                <span key={base} className="bp-deal" style={{ animationDelay: `${n * 90}ms` }}>
                  <PieceArt piece={piece} cell={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="note bp-help">Drag a piece onto the board, or tap a piece then a cell.</p>
      </section>

      {(matchPanel || run) && (
        <div className="bpx-foot">
          {matchPanel}
          <span className="mono bpx-seed" title="Your opponent gets this exact set of pieces">
            {phase === "idle" ? "Pieces —" : `Pieces #${st.seed.toString(16).padStart(16, "0").slice(0, 6)}`}
          </span>
        </div>
      )}

      {drag && (
        <div className="bp-ghost" style={{ transform: `translate(${drag.px}px, ${drag.py}px) translate(-50%, -50%)` }} aria-hidden="true">
          <PieceArt piece={pieceAt(st.seed, drag.idx)} cell={drag.cell} />
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    </div>
    </Arena>
  );
}

function footprintGem(piece: Piece, x: number, y: number): bigint {
  const c = pieceCells(piece).find((k) => k.gem);
  return c ? 1n << BigInt((y + c.dy) * SIZE + x + c.dx) : 0n;
}
