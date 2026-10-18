"use client";

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { prefersReducedMotion } from "../fx";
import { ARMY_NAME, NAMES, SIZE, type Army, type Depot, type Rank, type Square } from "./rules";

/** A piece as the viewer sees it right now (position may be between squares mid-animation). */
export interface ShownPiece {
  id: number;
  army: Army;
  rank: Rank;
  r: number;
  c: number;
  /** Face up to the viewer (own pieces always; enemy pieces while flashed or once Spotted). */
  up: boolean;
  /** Leaving the board: fades out, then the parent drops it. */
  gone?: boolean;
  /** Slide time for the next position change, in ms. */
  ms?: number;
}

export interface ShownFx {
  key: number;
  kind: "clash" | "mine" | "spotted";
  /** Centre, in squares (fractions allowed). */
  r: number;
  c: number;
  size: number;
}

export interface ShownStorm {
  key: number;
  axis: "row" | "col";
  index: number;
  dir: 1 | -1;
}

const face = (army: Army, key: string) => `url(/art/vanguard/faces/${army}-${key}.webp)`;

/** One marker in the B1 look: face over a dark wooden side, lit from above, shadow straight under. */
const Marker = memo(function Marker({ p, selected, onTap, disabled }: { p: ShownPiece; selected: boolean; onTap: (id: number) => void; disabled: boolean }) {
  const [shownUp, setShownUp] = useState(p.up);
  const pb = useRef<HTMLSpanElement>(null);
  const top = useRef<HTMLSpanElement>(null);
  const sh = useRef<HTMLSpanElement>(null);

  // the reveal: lift, turn over like a coin at the halfway point, land
  useEffect(() => {
    if (p.up === shownUp) return;
    if (prefersReducedMotion() || !pb.current || !top.current) {
      setShownUp(p.up);
      return;
    }
    const lift = [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-30%) scale(1.12)", offset: 0.3 }, { transform: "translateY(-30%) scale(1.12)", offset: 0.7 }, { transform: "translateY(0) scale(.97)", offset: 0.9 }, { transform: "translateY(0) scale(1)" }];
    pb.current.animate(lift, { duration: 560, easing: "ease-in-out" });
    sh.current?.animate([{ opacity: 1 }, { opacity: 0.4, transform: "translate(-6%, 18%) scale(1.15)", offset: 0.3 }, { opacity: 0.4, transform: "translate(-6%, 18%) scale(1.15)", offset: 0.7 }, { opacity: 1 }], { duration: 560, easing: "ease-in-out" });
    const el = top.current;
    let cancelled = false;
    const half = el.animate([{ transform: "perspective(260px) scaleY(.86) rotateX(0deg)" }, { transform: "perspective(260px) scaleY(.86) rotateX(90deg)" }], { duration: 130, delay: 150, easing: "ease-in", fill: "forwards" });
    half.onfinish = () => {
      if (cancelled) return;
      setShownUp(p.up);
      el.animate([{ transform: "perspective(260px) scaleY(.86) rotateX(-90deg)" }, { transform: "perspective(260px) scaleY(.86) rotateX(0deg)" }], { duration: 150, easing: "ease-out" });
      half.cancel();
    };
    return () => {
      cancelled = true;
    };
  }, [p.up, shownUp]);

  const style = {
    left: `calc(var(--vg-sq) * ${p.c})`,
    top: `calc(var(--vg-sq) * ${p.r})`,
    transitionDuration: `${p.ms ?? 0}ms`,
  } as CSSProperties;
  const label = shownUp ? `${p.army === "us" ? "US" : "Italian"} ${p.rank} ${NAMES[p.rank]}` : `${ARMY_NAME[p.army]} hidden piece`;
  return (
    <button
      type="button"
      className={`vg-piece ${p.army}${selected ? " sel" : ""}${p.gone ? " gone" : ""}`}
      style={style}
      aria-label={label}
      aria-pressed={selected || undefined}
      disabled={disabled}
      onClick={() => onTap(p.id)}
    >
      <span className="vg-pb" ref={pb}>
        <span className="vg-sh" ref={sh} />
        <span className="vg-side" />
        <span className="vg-top" ref={top}>
          <span className={`vg-face${shownUp ? "" : " back"}`}>
            <span className="vg-art" style={{ backgroundImage: face(p.army, shownUp ? p.rank : "back") }} />
            {shownUp && <span className="vg-rk">{p.rank}</span>}
          </span>
          <span className="vg-gloss" />
        </span>
      </span>
    </button>
  );
});

export interface VanguardBoardProps {
  pieces: ShownPiece[];
  depots: Depot[];
  selected: number | null;
  marks: (Square & { attack: boolean })[];
  fx: ShownFx[];
  storm: ShownStorm | null;
  /** Taps are off (not your turn, or an animation is playing). */
  locked: boolean;
  onPiece: (id: number) => void;
  onMark: (sq: Square) => void;
}

/**
 * The 10×10 board, top-down, from the US side. Pieces are positioned by square and slide with a CSS
 * transition; effects are painted sprites drawn with a screen blend; the Dust Storm is a haze over its line.
 */
export function VanguardBoard({ pieces, depots, selected, marks, fx, storm, locked, onPiece, onMark }: VanguardBoardProps) {
  return (
    <div className="vg-board" role="group" aria-label="Vanguard board">
      {depots.map((d) => (
        <span
          key={`${d.r},${d.c}`}
          className={`vg-depot${d.claimed ? " claimed" : ""}`}
          style={{ left: `calc(var(--vg-sq) * ${d.c + 0.5})`, top: `calc(var(--vg-sq) * ${d.r + 0.5})` }}
          role="img"
          aria-label={`Supply Depot, ${d.raider === "us" ? "yours to raid" : "Italy raids this one"}${d.claimed ? ", raided" : ""}`}
        />
      ))}
      {pieces.map((p) => (
        <Marker key={p.id} p={p} selected={selected === p.id} onTap={onPiece} disabled={locked && selected !== p.id} />
      ))}
      {marks.map((m) => (
        <button
          key={`${m.r},${m.c}`}
          type="button"
          className={`vg-mark${m.attack ? " atk" : ""}`}
          style={{ left: `calc(var(--vg-sq) * ${m.c})`, top: `calc(var(--vg-sq) * ${m.r})` }}
          aria-label={`${m.attack ? "Attack" : "Move to"} row ${SIZE - m.r}, column ${m.c + 1}`}
          disabled={locked}
          onClick={() => onMark(m)}
        />
      ))}
      {fx.map((f) => (
        <span
          key={f.key}
          className={`vg-fx ${f.kind}`}
          style={{ left: `calc(var(--vg-sq) * ${f.c})`, top: `calc(var(--vg-sq) * ${f.r})`, width: `calc(var(--vg-sq) * ${f.size})`, height: `calc(var(--vg-sq) * ${f.size})` }}
          aria-hidden="true"
        />
      ))}
      {storm && (
        <span key={storm.key} className={`vg-storm ${storm.axis}`} style={{ "--vg-line": storm.index, "--vg-dir": storm.dir } as CSSProperties} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}
