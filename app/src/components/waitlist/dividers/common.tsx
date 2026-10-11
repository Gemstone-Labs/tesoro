"use client";

import { useSyncExternalStore } from "react";
import { INNER, OUTER } from "../dissolve";
import { INSET, LINES } from "../geometry";

export type Kind = keyof typeof LINES;
export type Frame = { w: number; h: number; kind: Kind };
export type Pt = [number, number];
/** A drawn piece: the body takes the page colour and the texture, tones are light or shade of that same colour. */
export type Piece = { d: string; tone?: keyof typeof TONES };
/** One shape: its outline (filled with the texture) and the light and shade drawn over it. Later shapes cover earlier ones. */
export type Shape = { body: string; tones?: Piece[]; delay?: number; ox?: number; oy?: number; angle?: number };
export type Scene = Shape[];

export const BG = "#090d0f";
/** Light from above: the stone's own colour, a touch lighter facing the light and darker facing away. */
export const TONES = { hi: "rgba(234,239,236,0.24)", lighter: "rgba(234,239,236,0.085)", light: "rgba(234,239,236,0.045)", shade: "rgba(0,0,0,0.26)", deep: "rgba(0,0,0,0.42)", lo: "rgba(0,0,0,0.78)" } as const;
/** Direction towards the light: up and a little left. */
export const LIGHT: Pt = [-0.45, -0.89];

const subscribe = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
const frameKey = () => {
  const el = document.querySelector(".wl");
  return el ? `${el.clientWidth}x${el.clientHeight}x${matchMedia("(max-width: 640px)").matches ? "tall" : "wide"}` : "";
};

/** The frame's real size and which line applies; null until hydrated. */
export function useFrame(): Frame | null {
  const key = useSyncExternalStore(subscribe, frameKey, () => "");
  if (!key) return null;
  const [w, h, kind] = key.split("x");
  return { w: Number(w), h: Number(h), kind: kind as Kind };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (n) => {
      const m = matchMedia("(prefers-reduced-motion: reduce)");
      m.addEventListener("change", n);
      return () => m.removeEventListener("change", n);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

/** The diagonal in px: origin, unit tangent (down the line), unit normal (towards the footage), length. */
export type Geo = { px: number; py: number; ux: number; uy: number; nx: number; ny: number; len: number; k: number; inset: number };

export function geo(f: Frame): Geo {
  const l = LINES[f.kind];
  const px = l.x1 * f.w;
  const py = l.y1 * f.h;
  const dx = l.x2 * f.w - px;
  const dy = l.y2 * f.h - py;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const nx = uy;
  const ny = -ux;
  // Perpendicular depth the floor was pulled back by.
  const inset = f.kind === "wide" ? INSET.wide * Math.abs(uy) : INSET.tall * Math.abs(ux);
  // Size factor: shapes shrink on small frames.
  const k = f.kind === "tall" ? 0.5 : Math.min(Math.max(f.w / 1440, 0.82), 1.2);
  return { px, py, ux, uy, nx, ny, len, k, inset };
}

/** The point `s` px down the line and `o` px towards the footage. */
export const at = (g: Geo, s: number, o: number): Pt => [g.px + g.ux * s + g.nx * o, g.py + g.uy * s + g.ny * o];
/** Signed distance of a point from the line, positive towards the footage, and its position along it. */
export const dist = (g: Geo, x: number, y: number) => (x - g.px) * g.nx + (y - g.py) * g.ny;
export const along = (g: Geo, x: number, y: number) => (x - g.px) * g.ux + (y - g.py) * g.uy;

export const polyD = (pts: Pt[]) => `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`;
/** The texture's octagon outline (outer or inner) centred at cx,cy at scale s. */
export const octPts = (cx: number, cy: number, s: number, inner = false): Pt[] => (inner ? INNER : OUTER).map(([x, y]) => [cx + x * s, cy + y * s]);

/** A stable 0..1 per (a, b, salt). */
export function hash(a: number, b: number, salt = 0) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A strip along the line from `from` px inside the panel to a ridge `top(s)` px out: the rock bed the shapes grow from,
 * so there is never a plain straight edge between them.
 */
export function bed(g: Geo, top: (s: number) => number, step = 36): Pt[] {
  const s0 = -260;
  const s1 = g.len + 260;
  const outer: Pt[] = [];
  for (let s = s0; s <= s1; s += step) outer.push(at(g, s, top(s)));
  return [at(g, s0, -g.inset - 40), ...outer, at(g, s1, -g.inset - 40)];
}

/** The page's texture as an SVG pattern, anchored at the frame's origin so it runs on across the shapes. */
function Defs() {
  return (
    <defs>
      <pattern id="dv-tex" width="360" height="360" patternUnits="userSpaceOnUse">
        <rect width="360" height="360" fill={BG} />
        <g fill="none" stroke="#eaefec" strokeOpacity="0.045">
          <path d="M70 40h180l40 40v120l-40 40H70l-40-40V80z" />
          <path d="M98 68h124l28 28v88l-28 28H98l-28-28V96z" />
          <path d="M250 40l60-40M290 200l70 40M70 240l-70 60M30 80L0 60" />
        </g>
      </pattern>
    </defs>
  );
}

/** Renders a scene. A shape with `ox`/`oy` (its base) and `delay` grows from that point (variant F). */
export function SceneSvg({ frame, scene, grow = false }: { frame: Frame; scene: Scene; grow?: boolean }) {
  return (
    <svg className={`dv${grow ? " dv-grow" : ""}`} viewBox={`0 0 ${frame.w} ${frame.h}`} width={frame.w} height={frame.h} aria-hidden focusable="false">
      <Defs />
      {scene.map((sh, i) => {
        const inner = (
          <>
            <path d={sh.body} fill="url(#dv-tex)" />
            {sh.tones?.map((p, j) => (
              <path key={j} d={p.d} fill={TONES[p.tone ?? "light"]} />
            ))}
          </>
        );
        if (!grow || sh.ox === undefined) return <g key={i}>{inner}</g>;
        return (
          <g key={i} transform={`translate(${sh.ox.toFixed(1)} ${sh.oy!.toFixed(1)})`}>
            <g className="dv-g" style={{ "--d": `${(sh.delay ?? 0).toFixed(2)}s` } as React.CSSProperties}>
              <g transform={`translate(${(-sh.ox).toFixed(1)} ${(-sh.oy!).toFixed(1)})`}>{inner}</g>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
export { Defs as TextureDefs };
