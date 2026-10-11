import { INSET, LINES } from "../geometry";

export type Kind = keyof typeof LINES;
export type Frame = { w: number; h: number; kind: Kind };
export type Pt = [number, number];

/** The diagonal in px: origin, unit tangent (down the line), unit normal (towards the footage), length, and how far the floor was pulled back. */
export type Geo = { px: number; py: number; ux: number; uy: number; nx: number; ny: number; len: number; inset: number };

export function geo(f: Frame): Geo {
  const l = LINES[f.kind];
  const px = l.x1 * f.w;
  const py = l.y1 * f.h;
  const dx = l.x2 * f.w - px;
  const dy = l.y2 * f.h - py;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular depth the floor was pulled back by (sideways for the wide line, down for the tall one).
  const inset = f.kind === "wide" ? INSET.wide * Math.abs(uy) : INSET.tall * Math.abs(ux);
  return { px, py, ux, uy, nx: uy, ny: -ux, len, inset };
}

/** The point `s` px down the line and `o` px towards the footage. */
export const at = (g: Geo, s: number, o: number): Pt => [g.px + g.ux * s + g.nx * o, g.py + g.uy * s + g.ny * o];
/** Signed distance of a point from the line, positive towards the footage, and its position along it. */
export const dist = (g: Geo, x: number, y: number) => (x - g.px) * g.nx + (y - g.py) * g.ny;
export const along = (g: Geo, x: number, y: number) => (x - g.px) * g.ux + (y - g.py) * g.uy;

export const polyD = (pts: Pt[]) => `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`;

/** A strip along the line from well inside the panel to `top` px out: the solid ground the gems sit on. */
export function bed(g: Geo, top: number): Pt[] {
  const s0 = -260;
  const s1 = g.len + 260;
  return [at(g, s0, -g.inset - 40), at(g, s0, top), at(g, s1, top), at(g, s1, -g.inset - 40)];
}
