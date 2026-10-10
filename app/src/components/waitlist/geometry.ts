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
