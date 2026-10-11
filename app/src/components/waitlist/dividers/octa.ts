import { along, bed, dist, geo, polyD, type Frame, type Geo, type Pt } from "./geo";

/**
 * The divider: small flat octagon gems in the panel's own colour and texture, spreading from the panel into the footage.
 * Solid and fused next to the panel; past the front they come apart into separate gems in a regular checker-like pattern
 * (ordered dither), thinning to a few lone ones. The grid divides the 360px texture tile (30px, 20px on a phone) and is
 * centred on the texture's octagon centres, so the texture lines run along the gem rows.
 */
export const TILE_CENTRE = { x: 160, y: 140 };

export type Field = { g: Geo; frame: Frame; pitch: number; /** solid up to this distance past the diagonal */ solid: number; /** nothing beyond */ reach: number };

export function field(frame: Frame): Field {
  const g = geo(frame);
  const tall = frame.kind === "tall";
  return { g, frame, pitch: tall ? 20 : 30, solid: tall ? 18 : 36, reach: tall ? 130 : Math.min(Math.max(frame.w * 0.28, 300), 440) };
}

const smooth = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** Share of lattice sites with a gem past the solid zone: at most half (a checker), falling smoothly to none at the reach. */
const density = (fl: Field, d: number) => 0.5 * (1 - smooth((d - fl.solid) / (fl.reach - fl.solid))) ** 1.15;

/** Bayer matrix of order n (a power of two): 0..n*n-1, an ordered-dither threshold map. */
export function bayer(n: number): number[][] {
  if (n === 1) return [[0]];
  const h = bayer(n / 2);
  const m: number[][] = [];
  for (let y = 0; y < n; y++) {
    m.push([]);
    for (let x = 0; x < n; x++) {
      m[y].push(h[y % (n / 2)][x % (n / 2)] * 4 + [[0, 2], [3, 1]][Math.floor(y / (n / 2))][Math.floor(x / (n / 2))]);
    }
  }
  return m;
}
const B8 = bayer(8);
/** Ordered-dither threshold for lattice site (i, j), strictly inside (0, 1). */
export const threshold = (i: number, j: number) => (B8[((j % 8) + 8) % 8][((i % 8) + 8) % 8] + 0.5) / 64;

/** A regular octagon centred at cx, cy measuring `flats` across its flat sides. */
export function octagon(cx: number, cy: number, flats: number): Pt[] {
  const r = flats / 2 / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, k): Pt => [cx + r * Math.cos(Math.PI / 8 + (k * Math.PI) / 4), cy + r * Math.sin(Math.PI / 8 + (k * Math.PI) / 4)]);
}

/** Does lattice site (i, j) carry a gem, and is it part of the solid zone? One rule per site, so neighbours agree. */
export function siteAt(fl: Field, i: number, j: number) {
  const x = TILE_CENTRE.x + i * fl.pitch;
  const y = TILE_CENTRE.y + j * fl.pitch;
  const d = dist(fl.g, x, y);
  const solid = d <= fl.solid;
  return { x, y, d, solid, on: solid || density(fl, d) > threshold(i, j) };
}

/** The little diamond between four sites, where three or more of them are solid gems: octagons leave a hole there. */
function chip(fl: Field, i: number, j: number): string {
  const cells = [siteAt(fl, i, j), siteAt(fl, i + 1, j), siteAt(fl, i, j + 1), siteAt(fl, i + 1, j + 1)];
  if (cells.filter((c) => c.solid).length < 3) return "";
  const cx = cells[0].x + fl.pitch / 2;
  const cy = cells[0].y + fl.pitch / 2;
  const r = fl.pitch * 0.2929 * 1.08;
  return polyD([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
}

/** The ground strip and every gem (as one path each), for a frame of this size. */
export function dividerScene(frame: Frame): { ground: string; gems: string } {
  const fl = field(frame);
  const { g, pitch, reach } = fl;
  let gems = "";
  for (let i = Math.floor((-TILE_CENTRE.x - pitch) / pitch); TILE_CENTRE.x + i * pitch < frame.w + pitch; i++) {
    for (let j = Math.floor((-TILE_CENTRE.y - pitch) / pitch); TILE_CENTRE.y + j * pitch < frame.h + pitch; j++) {
      const s = siteAt(fl, i, j);
      const a = along(g, s.x, s.y);
      if (s.d < -g.inset * 0.5 || s.d > reach + pitch || a < -pitch * 2 || a > g.len + pitch * 2) continue;
      if (s.on) gems += polyD(octagon(s.x, s.y, pitch * (s.solid ? 1.04 : 0.86)));
      if (s.d <= fl.solid + pitch) gems += chip(fl, i, j);
    }
  }
  return { ground: polyD(bed(g, pitch * 0.2)), gems };
}
