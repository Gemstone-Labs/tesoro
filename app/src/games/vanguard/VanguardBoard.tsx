"use client";

import { memo, useLayoutEffect, useRef, type CSSProperties } from "react";
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

/** The marker's tilt toward the viewer at rest (the B1 look: face at cos 30° = 86% height, edge below). */
const TILT = 30;
const coinAt = (deg: number) => `rotateX(${TILT}deg) rotateY(${deg}deg)`;
/** Depths (in thicknesses from the middle) of the wooden discs that make the edge; the outer two show at rest. */
const WOOD = [-0.49, -0.42, -0.35, -0.28, -0.21, -0.14, -0.07, 0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.49];

/** The reveal: the whole coin lifts, spins half a turn on its upright axis (face, edge and back together), and lands. */
function flip(pb: HTMLElement, coin: HTMLElement, sh: HTMLElement) {
  coin.classList.add("flipping");
  const spin = coin.animate([{ transform: coinAt(180) }, { transform: coinAt(180), offset: 0.12 }, { transform: coinAt(360), offset: 0.82 }, { transform: coinAt(360) }], { duration: 620, easing: "cubic-bezier(.45,.05,.35,1)" });
  spin.onfinish = spin.oncancel = () => coin.classList.remove("flipping");
  pb.animate([{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-34%) scale(1.14)", offset: 0.45 }, { transform: "translateY(0) scale(1)", offset: 0.88 }, { transform: "translateY(2%) scale(.98)", offset: 0.94 }, { transform: "translateY(0) scale(1)" }], { duration: 620, easing: "ease-in-out" });
  sh.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0.35, transform: "translateY(12%) scale(.8)", offset: 0.45 }, { opacity: 1, transform: "scale(1)", offset: 0.88 }, { opacity: 1, transform: "scale(1)" }], { duration: 620, easing: "ease-in-out" });
}

/** One marker in the B1 look: face over a dark wooden side, lit from above, shadow straight under. */
export const Marker = memo(function Marker({ p, selected, onTap, disabled }: { p: ShownPiece; selected: boolean; onTap: (id: number) => void; disabled: boolean }) {
  const shownUp = p.up;
  const wasUp = useRef(p.up);
  const pb = useRef<HTMLSpanElement>(null);
  const coin = useRef<HTMLSpanElement>(null);
  const sh = useRef<HTMLSpanElement>(null);

  // hidden -> face: start the flip before the browser paints, so the new face never shows early
  useLayoutEffect(() => {
    const was = wasUp.current;
    wasUp.current = p.up;
    if (was || !p.up || prefersReducedMotion() || !pb.current || !coin.current || !sh.current) return;
    flip(pb.current, coin.current, sh.current);
  }, [p.up]);

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
        <span className="vg-coin3d">
          <span className="vg-coin" ref={coin} style={{ transform: coinAt(shownUp ? 0 : 180) }}>
            {WOOD.map((z) => (
              <span key={z} className={`vg-c wood${Math.abs(z) > 0.45 ? " rest" : ""}`} style={{ "--z": z } as CSSProperties} />
            ))}
            <span className="vg-c back">
              <span className="vg-face back">
                <span className="vg-art" style={{ backgroundImage: face(p.army, "back") }} />
              </span>
            </span>
            <span className="vg-c front">
              <span className={`vg-face${shownUp ? "" : " back"}`}>
                <span className="vg-art" style={{ backgroundImage: face(p.army, shownUp ? p.rank : "back") }} />
                {shownUp && <span className="vg-rk">{p.rank}</span>}
              </span>
              <span className="vg-gloss" />
            </span>
          </span>
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
