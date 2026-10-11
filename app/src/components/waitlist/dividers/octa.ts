import { TILE_CENTRE } from "../dissolve";
import { along, bed, dist, geo, polyD, type Frame, type Geo, type Pt } from "./common";

/**
 * Small octagon gems for the "consuming" variants (A1 to A4). Every gem is flat and in the panel's own colour and texture, so
 * the panel seems to spread into the footage: packed and fused next to it, then coming apart into separate gems in a regular
 * pattern, then a few lone ones. The grid divides the texture tile (30px, 20px on a phone) and is centred on the texture's
 * octagon centres, so the texture lines on the panel run along gem rows.
 */
export type Field = {
  g: Geo;
  frame: Frame;
  /** Grid pitch, px. */
  pitch: number;
  /** Fully packed up to this distance from the diagonal. */
  packed: number;
  /** Nothing beyond this distance. */
  reach: number;
};

export function field(frame: Frame): Field {
  const g = geo(frame);
  const tall = frame.kind === "tall";
  return { g, frame, pitch: tall ? 20 : 30, packed: tall ? 50 : 130, reach: tall ? 180 : Math.min(Math.max(frame.w * 0.37, 360), 580) };
}

const smooth = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** Share of grid sites that carry a gem at distance d: 1 while packed, then a smooth fall to 0 at the reach. */
export const density = (fl: Field, d: number, from = fl.packed) => (d <= from ? 1 : (1 - smooth((d - from) / (fl.reach - from))) ** 1.05);

/** Gem size (as a share of the pitch) for the share of sites still filled: overlapping while dense, clear gaps once they come apart. */
export const gemSize = (p: number) => 0.84 + 0.18 * Math.min(Math.max((p - 0.5) / 0.3, 0), 1);

/** Density from which gems are drawn fused (overlapping, with chips in the corners between them). */
export const FUSED = 0.8;

/** Bayer matrix of order n (a power of two), values 0..n*n-1 as an ordered-dither threshold map. */
export function bayer(n: number): number[][] {
  if (n === 1) return [[0]];
  const h = bayer(n / 2);
  const m: number[][] = [];
  for (let y = 0; y < n; y++) {
    m.push([]);
    for (let x = 0; x < n; x++) {
      const base = h[y % (n / 2)][x % (n / 2)] * 4;
      m[y].push(base + [[0, 2], [3, 1]][Math.floor(y / (n / 2))][Math.floor(x / (n / 2))]);
    }
  }
  return m;
}
const B8 = bayer(8);
/** Ordered-dither threshold for lattice site (i, j), in (0, 1). */
export const threshold = (i: number, j: number) => (B8[((j % 8) + 8) % 8][((i % 8) + 8) % 8] + 0.5) / 64;

/** A regular octagon centred at cx, cy measuring `flats` across its flat sides. */
export function octagon(cx: number, cy: number, flats: number): Pt[] {
  const r = flats / 2 / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, k): Pt => [cx + r * Math.cos(Math.PI / 8 + (k * Math.PI) / 4), cy + r * Math.sin(Math.PI / 8 + (k * Math.PI) / 4)]);
}

export type Site = { i: number; j: number; x: number; y: number; d: number; s: number };

/** Every lattice site near the diagonal, inside the frame, up to the reach, with its distance from the line. */
export function* sites(fl: Field, offset = 0): Generator<Site> {
  const { g, frame, pitch, reach } = fl;
  const x0 = TILE_CENTRE.x + offset;
  const y0 = TILE_CENTRE.y + offset;
  for (let i = Math.floor((-x0 - pitch) / pitch); x0 + i * pitch < frame.w + pitch; i++) {
    for (let j = Math.floor((-y0 - pitch) / pitch); y0 + j * pitch < frame.h + pitch; j++) {
      const x = x0 + i * pitch;
      const y = y0 + j * pitch;
      const d = dist(g, x, y);
      const s = along(g, x, y);
      if (d < -g.inset * 0.5 || d > reach + pitch || s < -pitch * 2 || s > g.len + pitch * 2) continue;
      yield { i, j, x, y, d, s };
    }
  }
}

/** The solid ground next to the panel: from well inside it to just past the diagonal, so no edge shows behind the gems. */
export const ground = (fl: Field) => ({ body: polyD(bed(fl.g, () => fl.pitch * 0.2, 30)) });

/** Does lattice site (i, j) carry a gem, and how dense is it there? (Same rule for every site, so neighbours agree.) */
export function siteAt(fl: Field, i: number, j: number) {
  const x = TILE_CENTRE.x + i * fl.pitch;
  const y = TILE_CENTRE.y + j * fl.pitch;
  const p = density(fl, dist(fl.g, x, y));
  return { x, y, p, on: p > threshold(i, j) };
}

/**
 * The little diamonds between four fused gems. Octagons on a square lattice leave a small diamond at each corner; filling it
 * where all four neighbours are fused keeps the packed zone solid, with no grid of holes.
 */
export function chip(fl: Field, i: number, j: number): string {
  const cells = [siteAt(fl, i, j), siteAt(fl, i + 1, j), siteAt(fl, i, j + 1), siteAt(fl, i + 1, j + 1)];
  if (!cells.every((c) => c.on && c.p >= FUSED)) return "";
  const cx = cells[0].x + fl.pitch / 2;
  const cy = cells[0].y + fl.pitch / 2;
  const r = fl.pitch * 0.2929 * 1.08;
  return polyD([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
}
