import { LINES, type Line } from "./geometry";

/**
 * The octagon cells of the dissolve: the landing's texture octagon (`--lp-texture`, 360px tile, one 260x200
 * octagon centred at 160,140 with a smaller one inside) at a fraction of its size, on a grid that divides the tile
 * (90px, or 60px on a phone) and is centred on the same octagon centres. Solid next to the diagonal, sparser and
 * smaller towards the footage.
 */
export const TILE = 360;
export const TILE_CENTRE = { x: 160, y: 140 };
export const OUTER: [number, number][] = [[-90, -100], [90, -100], [130, -60], [130, 60], [90, 100], [-90, 100], [-130, 60], [-130, -60]];
export const INNER: [number, number][] = [[-62, -72], [62, -72], [90, -44], [90, 44], [62, 72], [-62, 72], [-90, 44], [-90, -44]];

export type Variant = keyof typeof LINES;
export type Cell = { key: string; x: number; y: number; scale: number; fade: boolean; k: number };

/** pitch: grid step (divides TILE); size: cell scale against the texture octagon at full cover; depth: reach, px. */
const SETUP = {
  wide: { pitch: 90, size: 0.36, depth: (w: number) => Math.min(Math.max(w * 0.34, 220), 540) },
  tall: { pitch: 60, size: 0.22, depth: () => 170 },
} as const;

/** A stable 0..1 per grid cell, so a resize keeps the same cells. */
function hash(i: number, j: number, salt: number) {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function dissolveCells(w: number, h: number, variant: Variant): Cell[] {
  const line: Line = LINES[variant];
  const { pitch, size, depth } = SETUP[variant];
  const reach = depth(w);
  const px = line.x1 * w;
  const py = line.y1 * h;
  const dx = line.x2 * w - px;
  const dy = line.y2 * h - py;
  const len = Math.hypot(dx, dy);
  // Unit normal towards the footage (up).
  const nx = dy / len;
  const ny = -dx / len;
  const cells: Cell[] = [];
  const i0 = Math.floor((-TILE_CENTRE.x - pitch) / pitch);
  const j0 = Math.floor((-TILE_CENTRE.y - pitch) / pitch);
  for (let i = i0; TILE_CENTRE.x + i * pitch < w + pitch; i++) {
    for (let j = j0; TILE_CENTRE.y + j * pitch < h + pitch; j++) {
      const x = TILE_CENTRE.x + i * pitch;
      const y = TILE_CENTRE.y + j * pitch;
      const d = (x - px) * nx + (y - py) * ny;
      if (d < -pitch * 0.45 || d > reach) continue;
      const t = Math.min(Math.max(d / reach, 0), 1);
      if (t > 0.1 && hash(i, j, 1) > 1 - 0.97 * ((t - 0.1) / 0.9) ** 1.3) continue;
      const scale = (d <= 0 ? 1.1 : Math.max(1.1 - 0.8 * t ** 0.8, 0.3)) * size;
      cells.push({ key: `${i}:${j}`, x, y, scale, fade: t > 0.25 && hash(i, j, 2) < 0.08, k: Math.round(hash(i, j, 3) * 9) });
    }
  }
  return cells;
}
