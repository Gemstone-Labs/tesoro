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

/** How a hidden piece shows its face (founder is picking one; the coin flip was rejected). */
export type RevealStyle = "fade" | "lid" | "wipe" | "dust" | "stamp";
export const REVEAL_STYLES: RevealStyle[] = ["fade", "lid", "wipe", "dust", "stamp"];

/**
 * The reveal. The face is already in place underneath; a copy of the brass back sits on top (`cover`)
 * and goes away in the chosen style. The piece itself never turns over.
 */
function playReveal(style: RevealStyle, el: { pb: HTMLElement; cover: HTMLElement; streak: HTMLElement; ring: HTMLElement; puff: HTMLElement; top: HTMLElement }) {
  const o = { fill: "none" as const };
  if (style === "fade") {
    el.cover.animate([{ opacity: 1 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { ...o, duration: 520, easing: "ease-out" });
    el.top.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.3)", offset: 0.4 }, { filter: "brightness(1)" }], { duration: 700, easing: "ease-out" });
  } else if (style === "lid") {
    el.cover.animate([{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 1, transform: "translateY(-14%) scale(1.04)", offset: 0.35 }, { opacity: 0, transform: "translateY(-60%) scale(1.1)" }], { ...o, duration: 520, easing: "ease-in" });
  } else if (style === "wipe") {
    el.cover.animate([{ opacity: 1, clipPath: "inset(0 0 0 0)" }, { opacity: 1, clipPath: "inset(0 0 0 100%)" }], { ...o, duration: 460, easing: "ease-in-out" });
    el.streak.animate([{ opacity: 0, transform: "translateX(-60%) skewX(-18deg)" }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0, transform: "translateX(160%) skewX(-18deg)" }], { duration: 460, easing: "ease-in-out" });
  } else if (style === "dust") {
    el.puff.animate([{ opacity: 0, transform: "translate(-50%, -50%) scale(.5)" }, { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.3 }, { opacity: 0, transform: "translate(-50%, -50%) scale(1.25)" }], { duration: 760, easing: "ease-out" });
    el.cover.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.42 }, { opacity: 0 }], { ...o, duration: 760 });
  } else {
    el.pb.animate([{ transform: "scale(1)" }, { transform: "scale(.9)", offset: 0.3 }, { transform: "scale(1.08)", offset: 0.55 }, { transform: "scale(1)" }], { duration: 480, easing: "ease-out" });
    el.cover.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.31 }, { opacity: 0 }], { ...o, duration: 480 });
    el.ring.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 0, transform: "scale(.9)", offset: 0.3 }, { opacity: 1, transform: "scale(1)", offset: 0.4 }, { opacity: 0, transform: "scale(1.45)" }], { duration: 640, easing: "ease-out" });
  }
}

/** One marker in the B1 look: face over a dark wooden side, lit from above, shadow straight under. */
export const Marker = memo(function Marker({ p, selected, onTap, disabled, reveal = "fade" }: { p: ShownPiece; selected: boolean; onTap: (id: number) => void; disabled: boolean; reveal?: RevealStyle }) {
  const shownUp = p.up;
  const wasUp = useRef(p.up);
  const pb = useRef<HTMLSpanElement>(null);
  const top = useRef<HTMLSpanElement>(null);
  const cover = useRef<HTMLSpanElement>(null);
  const streak = useRef<HTMLSpanElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const puff = useRef<HTMLSpanElement>(null);

  // before the browser paints the new face, put the cover over it and play it away
  useLayoutEffect(() => {
    const was = wasUp.current;
    wasUp.current = p.up;
    if (was || !p.up || prefersReducedMotion() || !pb.current || !top.current || !cover.current || !streak.current || !ring.current || !puff.current) return;
    playReveal(reveal, { pb: pb.current, top: top.current, cover: cover.current, streak: streak.current, ring: ring.current, puff: puff.current });
  }, [p.up, reveal]);

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
        <span className="vg-sh" />
        <span className="vg-side" />
        <span className="vg-top" ref={top}>
          <span className={`vg-face${shownUp ? "" : " back"}`}>
            <span className="vg-art" style={{ backgroundImage: face(p.army, shownUp ? p.rank : "back") }} />
            {shownUp && <span className="vg-rk">{p.rank}</span>}
          </span>
          <span className="vg-cover" ref={cover} aria-hidden="true">
            <span className="vg-face back">
              <span className="vg-art" style={{ backgroundImage: face(p.army, "back") }} />
            </span>
          </span>
          <span className="vg-clip" aria-hidden="true">
            <span className="vg-streak" ref={streak} />
          </span>
          <span className="vg-ring-flash" ref={ring} aria-hidden="true" />
          <span className="vg-gloss" />
        </span>
        <span className="vg-puff" ref={puff} aria-hidden="true" />
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
  reveal?: RevealStyle;
}

/**
 * The 10×10 board, top-down, from the US side. Pieces are positioned by square and slide with a CSS
 * transition; effects are painted sprites drawn with a screen blend; the Dust Storm is a haze over its line.
 */
export function VanguardBoard({ pieces, depots, selected, marks, fx, storm, locked, onPiece, onMark, reveal }: VanguardBoardProps) {
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
        <Marker key={p.id} p={p} selected={selected === p.id} onTap={onPiece} disabled={locked && selected !== p.id} reveal={reveal} />
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
