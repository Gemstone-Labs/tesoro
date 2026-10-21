import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useMemo, useState } from "react";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { BlockBoard } from "@/components/game/BlockBoard";
import { SIZE, apply, dims, fitsAt, handBase, newState, pieceAt, pieceCells, type Piece, type State } from "@/games/block-puzzle/engine";
import "@/games/block-puzzle/block-puzzle.css";

const noop = () => undefined;

function Match({ seed }: { seed: number }) {
  const [run] = useState<MatchRun>(() => ({ seed: BigInt(seed), startedAt: performance.now(), entry: 1000, onMove: noop, onEnd: noop }));
  return (
    <BlockPuzzleGame
      run={run}
      matchPanel={
        <div className="bpx-status" role="status">
          <p>Your opponent gets the same pieces · waiting to be paired</p>
          <span className="bpx-finding">
            <i className="bpx-spin" aria-hidden="true" /> Finding opponent…
          </span>
        </div>
      }
    />
  );
}

const meta = {
  title: "Games/Block Puzzle",
  parameters: { layout: "padded", shell: "app" },
} satisfies Meta;
export default meta;

/** Practice: nothing staked, a fresh random set of pieces each time. It counts 3-2-1 and starts as soon as it opens. */
export const Practice: StoryObj = { render: () => <BlockPuzzleGame /> };

/** A Match run on a fixed set of pieces; change the seed in Controls to get another set. Drag a piece onto the board, or tap a piece then a cell. */
export const PlayWithSeed: StoryObj<{ seed: number }> = {
  args: { seed: 1592381 },
  argTypes: { seed: { control: { type: "number" } } },
  render: (a) => <Match key={a.seed} seed={a.seed} />,
};

/* ——— Board states, built by replaying the engine ——— */

interface Played {
  st: State;
  colors: number[];
  lines: number;
}

/** A greedy player: the move that scores most, preferring the lowest cell. */
function play(seed: bigint, moves: number): Played {
  let st = newState(seed);
  const colors: number[] = Array(SIZE * SIZE).fill(0);
  let lines = 0;
  for (let n = 0; n < moves && !st.over; n++) {
    const base = handBase(st);
    let best: { piece: number; x: number; y: number; gained: number } | null = null;
    for (let k = 0; k < 3; k++) {
      if ((st.used >> k) & 1) continue;
      const piece = pieceAt(st.seed, base + k);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (!fitsAt(st, piece, x, y)) continue;
          const g = apply(st, { piece: base + k, x, y }).result.gained * 100 + y;
          if (!best || g > best.gained) best = { piece: base + k, x, y, gained: g };
        }
      }
    }
    if (!best) break;
    const piece = pieceAt(st.seed, best.piece);
    const out = apply(st, { piece: best.piece, x: best.x, y: best.y });
    for (const c of pieceCells(piece)) colors[(best.y + c.dy) * SIZE + best.x + c.dx] = piece.kind % 4;
    lines += out.result.lines;
    st = out.state;
  }
  return { st, colors, lines };
}

function Mini({ piece }: { piece: Piece }) {
  const [w, h] = dims(piece);
  return (
    <span className="bp-mini" style={{ gridTemplateColumns: `repeat(${w}, 16px)`, gridTemplateRows: `repeat(${h}, 16px)` }} aria-hidden="true">
      {pieceCells(piece).map((c) => (
        <i key={`${c.dx}${c.dy}`} className={`bp-cell k${piece.kind % 4}${c.gem ? " gem" : ""}`} style={{ gridColumn: c.dx + 1, gridRow: c.dy + 1 }} />
      ))}
    </span>
  );
}

/** The play screen's markup, drawn from an engine state (the real component cannot take one). */
function Frozen({ moves, title }: { moves: number; title: string }) {
  const { st, colors, lines } = useMemo(() => play(0x5eed1234abcdn, moves), [moves]);
  const base = handBase(st);
  return (
    <div style={{ width: 380 }}>
      <p className="label" style={{ marginBottom: 8 }}>{title} · {st.moves} moves</p>
      <div className="bpx">
        <header className="cut cut-card bpx-bar" aria-label="Match">
          <div className="bpx-score">
            <span className="bp-score-n tnum">{st.score}</span>
          </div>
          <div className="bpx-ring" role="timer" aria-label="Time left">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="54" className="bpx-ring-bg" />
              <circle cx="60" cy="60" r="54" className="bpx-ring-fg" strokeDasharray={339.3} strokeDashoffset={339.3 * (st.over ? 1 : 0.4)} transform="rotate(-90 60 60)" />
            </svg>
            <span className="mono">{st.over ? "00:00" : "00:54"}</span>
          </div>
          <div className="bpx-run">
            <span>Lines <b className="tnum">{lines}</b></span>
          </div>
        </header>
        <section className="bpx-mid" style={{ maxWidth: "100%" }} aria-label="Board">
          <div className="bp-stage">
            <div className="bp-board" role="img" aria-label="Block Puzzle board">
              {Array.from({ length: SIZE * SIZE }, (_, i) => {
                const on = (st.occ >> BigInt(i)) & 1n;
                const gem = (st.gems >> BigInt(i)) & 1n;
                return <span key={i} className={`bp-cell${on ? ` k${colors[i]} on` : ""}${on && gem ? " gem" : ""}`} />;
              })}
            </div>
            {st.over && (
              <div className="bp-overlay" role="dialog" aria-label="Game over">
                <div className="stack" style={{ justifyItems: "center", textAlign: "center" }}>
                  <span className="label">No piece fits</span>
                  <span className="bp-final tnum">{st.score}</span>
                  <p className="meta tnum">{st.moves} moves · {lines} lines</p>
                </div>
              </div>
            )}
          </div>
          <div className="bp-tray" aria-label="Pieces">
            {[0, 1, 2].map((n) => {
              const used = st.over || ((st.used >> n) & 1) === 1;
              return (
                <span key={n} className={`cut cut-btn bp-slot${used ? " used" : n === 0 ? " sel" : ""}`}>
                  {!used && <Mini piece={pieceAt(st.seed, base + n)} />}
                </span>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export const FreshBoard: StoryObj = { render: () => <Frozen moves={0} title="Fresh" /> };
export const MidRun: StoryObj = { render: () => <Frozen moves={21} title="Mid-run" /> };
export const GameOver: StoryObj = { render: () => <Frozen moves={500} title="Game over" /> };

/** The three board states side by side. */
export const States: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      <Frozen moves={0} title="Fresh" />
      <Frozen moves={21} title="Mid-run" />
      <Frozen moves={500} title="Game over" />
    </div>
  ),
};

/** The little board art on game tiles and the Lobby (components/game/BlockBoard.tsx), for a few seeds. */
export const TileArt: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 260px)", gap: 16 }}>
      {[11, 3, 27, 90].map((seed) => (
        <BlockBoard key={seed} seed={seed} />
      ))}
    </div>
  ),
};
