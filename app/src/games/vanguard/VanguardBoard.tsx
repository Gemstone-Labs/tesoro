"use client";

import { memo, useLayoutEffect, useRef, type CSSProperties } from "react";
import { prefersReducedMotion } from "../fx";
import { ARMY_NAME, NAMES, SIZE, type Army, type Depot, type Rank, type Square } from "./rules";

/** A piece as the viewer sees it right now (position may be between squares mid-animation). */
export interface ShownPiece {
  id: number;
  army: Army;
  /** Null while the viewer cannot know it: an enemy piece that is still face down. */
  rank: Rank | null;
  r: number;
  c: number;
  /** Face up to the viewer (own pieces always; enemy pieces while flashed or once Spotted). */
  up: boolean;
  /** Leaving the board: fades out, then the parent drops it. */
  gone?: boolean;
  /** Slide time for the next position change, in ms. */
  ms?: number;
  /** Set with `up` for a reveal: the side the piece was hit from (its flip starts there). */
  hitFrom?: HitSide;
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
/**
 * The wooden edge. At rest two dark discs just inside the faces draw it (the edge you see below the face);
 * while flipping, a ring of narrow wooden panels around the rim makes a solid edge at every angle.
 */
const REST = [-0.49, 0.49];
const PANELS = Array.from({ length: 24 }, (_, i) => i);

/** The side a piece was hit from; its reveal flips from that side. */
export type HitSide = "left" | "right" | "top" | "bottom";

/**
 * The reveal: the whole coin lifts, turns over half a turn (face, edge and back together) and lands.
 * The side it was hit from rises first and it tumbles away from the hit: hit from the left, it turns over
 * to the right on its upright axis; hit from the top, it turns over downward on its level axis.
 * A level-axis turn starts from the back turned the same way (`vflip`), so the brass never jumps.
 */
function flip(pb: HTMLElement, coin: HTMLElement, sh: HTMLElement, from: HitSide) {
  const level = from === "top" || from === "bottom";
  const axis = level ? "rotateX" : "rotateY";
  const end = from === "left" || from === "bottom" ? 360 : 0;
  const at = (deg: number) => `rotateX(${TILT}deg) ${axis}(${deg}deg)`;
  coin.classList.add("flipping");
  coin.classList.toggle("vflip", level);
  const spin = coin.animate([{ transform: at(180) }, { transform: at(180), offset: 0.12 }, { transform: at(end), offset: 0.82 }, { transform: at(end) }], { duration: 620, easing: "cubic-bezier(.45,.05,.35,1)" });
  spin.onfinish = spin.oncancel = () => coin.classList.remove("flipping", "vflip");
  // pushed a little away from the hit while in the air
  const [dx, dy] = { left: [10, 0], right: [-10, 0], top: [0, 8], bottom: [0, -8] }[from];
  const air = (k: number) => `translate(${dx * k}%, ${dy * k - 34 * k}%) scale(${1 + 0.14 * k})`;
  pb.animate([{ transform: air(0) }, { transform: air(1), offset: 0.45 }, { transform: air(0), offset: 0.88 }, { transform: "translateY(2%) scale(.98)", offset: 0.94 }, { transform: air(0) }], { duration: 620, easing: "ease-in-out" });
  sh.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0.35, transform: `translate(${dx}%, ${12 + dy}%) scale(.8)`, offset: 0.45 }, { opacity: 1, transform: "scale(1)", offset: 0.88 }, { opacity: 1, transform: "scale(1)" }], { duration: 620, easing: "ease-in-out" });
}

/** One marker in the B1 look: face over a dark wooden side, lit from above, shadow straight under. */
export const Marker = memo(function Marker({ p, selected, target = false, onTap, disabled }: { p: ShownPiece; selected: boolean; target?: boolean; onTap: (id: number) => void; disabled: boolean }) {
  const shownUp = p.up && p.rank !== null;
  const wasUp = useRef(p.up && p.rank !== null);
  const pb = useRef<HTMLSpanElement>(null);
  const coin = useRef<HTMLSpanElement>(null);
  const sh = useRef<HTMLSpanElement>(null);

  // hidden -> face: start the flip before the browser paints, so the new face never shows early
  useLayoutEffect(() => {
    const was = wasUp.current;
    wasUp.current = shownUp;
    if (was || !shownUp || prefersReducedMotion() || !pb.current || !coin.current || !sh.current) return;
    flip(pb.current, coin.current, sh.current, p.hitFrom ?? "left");
  }, [shownUp, p.hitFrom]);

  const style = {
    left: `calc(var(--vg-sq) * ${p.c})`,
    top: `calc(var(--vg-sq) * ${p.r})`,
    transitionDuration: `${p.ms ?? 0}ms`,
  } as CSSProperties;
  const label = shownUp && p.rank ? `${p.army === "us" ? "US" : "Italian"} ${p.rank} ${NAMES[p.rank]}` : `${ARMY_NAME[p.army]} hidden piece`;
  return (
    <button
      type="button"
      className={`vg-piece ${p.army}${selected ? " sel" : ""}${target ? " tgt" : ""}${p.gone ? " gone" : ""}`}
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
            {REST.map((z) => (
              <span key={z} className="vg-c wood" style={{ "--z": z } as CSSProperties} />
            ))}
            {PANELS.map((i) => (
              <span key={i} className="vg-panel" style={{ "--i": i } as CSSProperties} />
            ))}
            <span className="vg-c back">
              <span className="vg-face back">
                <span className="vg-art" style={{ backgroundImage: face(p.army, "back") }} />
              </span>
            </span>
            <span className="vg-c front">
              <span className={`vg-face${shownUp ? "" : " back"}`}>
                <span className="vg-art" style={{ backgroundImage: face(p.army, shownUp && p.rank ? p.rank : "back") }} />
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
  /** The army whose Player is looking; its depot is the one "yours to raid". Defaults to the US. */
  viewer?: Army;
  onPiece: (id: number) => void;
  onMark: (mark: Square & { attack: boolean }) => void;
}

/**
 * The 10×10 board, top-down, from the US side. Pieces are positioned by square and slide with a CSS
 * transition; effects are painted sprites drawn with a screen blend; the Dust Storm is a haze over its line.
 */
export function VanguardBoard({ pieces, depots, selected, marks, fx, storm, locked, viewer = "us", onPiece, onMark }: VanguardBoardProps) {
  const targets = new Set(marks.filter((m) => m.attack).map((m) => m.r * SIZE + m.c));
  return (
    <div className="vg-board" role="group" aria-label="Vanguard board">
      {depots.map((d) => (
        <span
          key={`${d.r},${d.c}`}
          className={`vg-depot${d.claimed ? " claimed" : ""}`}
          style={{ left: `calc(var(--vg-sq) * ${d.c + 0.5})`, top: `calc(var(--vg-sq) * ${d.r + 0.5})` }}
          role="img"
          aria-label={`Supply Depot, ${d.raider === viewer ? "yours to raid" : "the enemy raids this one"}${d.claimed ? ", raided" : ""}`}
        />
      ))}
      {pieces.map((p) => (
        <Marker key={p.id} p={p} selected={selected === p.id} target={!p.gone && targets.has(p.r * SIZE + p.c)} onTap={onPiece} disabled={locked && selected !== p.id} />
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
