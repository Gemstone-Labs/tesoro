/**
 * The diagonal that splits the frame, in fractions of the frame (x right, y down). The video wall's clip-path
 * and the gem divider are both built from it, so they line up at every viewport. Videos sit above the line,
 * the form below it. `wide` is the desktop frame, `tall` the phone one (wall on top, form below).
 */
export type Line = { x1: number; y1: number; x2: number; y2: number };

export const LINES = {
  wide: { x1: 0.2, y1: 0, x2: 0.97, y2: 1 },
  tall: { x1: 0, y1: 0.44, x2: 1, y2: 0.31 },
} as const satisfies Record<string, Line>;

/** The frame size each line's blocks are laid out for; block sizes are fractions of this width. */
export const DESIGN = { wide: { w: 1440, h: 900 }, tall: { w: 390, h: 760 } } as const;

const pct = (n: number) => `${+(n * 100).toFixed(3)}%`;

const start = (l: Line) => `${pct(l.x1)} ${pct(l.y1)}`;
const end = (l: Line) => `${pct(l.x2)} ${pct(l.y2)}`;

/**
 * The region above the line, as a CSS polygon. The line starts on the left or top edge and ends on the bottom
 * or right edge; the polygon closes through the frame corners on its side.
 */
export function clipAbove(l: Line): string {
  const pts = [start(l), end(l)];
  if (l.y2 >= 1) pts.push("100% 100%");
  pts.push("100% 0");
  if (l.x1 <= 0) pts.push("0 0");
  return `polygon(${pts.join(", ")})`;
}

/** The region below the line: the solid floor the form stands on. */
export function clipBelow(l: Line): string {
  const pts = [start(l), end(l)];
  if (l.y2 < 1) pts.push("100% 100%");
  pts.push("0 100%");
  if (l.y1 <= 0) pts.push("0 0");
  return `polygon(${pts.join(", ")})`;
}

/**
 * Divider variants (?d=a..f) draw their own edge, so the floor's straight edge is pulled back under them: the line
 * moved `inset` px into the panel (sideways for the wide line, down for the tall one).
 */
export const INSET = { wide: 130, tall: 60 } as const;

export function clipBelowInset(l: Line, inset: number, axis: "x" | "y"): string {
  const sx = axis === "x" ? `calc(${pct(l.x1)} - ${inset}px)` : pct(l.x1);
  const sy = axis === "y" ? `calc(${pct(l.y1)} + ${inset}px)` : pct(l.y1);
  const ex = axis === "x" ? `calc(${pct(l.x2)} - ${inset}px)` : pct(l.x2);
  const ey = axis === "y" ? `calc(${pct(l.y2)} + ${inset}px)` : pct(l.y2);
  const pts = [`${sx} ${sy}`, `${ex} ${ey}`];
  if (l.y2 < 1) pts.push("100% 100%");
  pts.push("0 100%");
  if (l.y1 <= 0) pts.push("0 0");
  return `polygon(${pts.join(", ")})`;
}
