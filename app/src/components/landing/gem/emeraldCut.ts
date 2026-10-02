/**
 * A procedural emerald cut: a stack of octagonal rings (table → crown steps → girdle → pavilion steps → keel)
 * joined by flat facets. Width (z) is 1; length (x) is `ratio`; y is up with the girdle at 0.
 * Returns non-indexed triangle positions so every facet keeps its own flat normal.
 */
export type EmeraldCutParams = {
  ratio: number;
  /** Corner chamfer leg at the girdle, as a fraction of the width. */
  corner: number;
  /** Table width as a fraction of the width. */
  table: number;
  girdle: number;
  /** Crown steps from the table out to the girdle: [inset from girdle outline, height above girdle top]. */
  crown: [number, number][];
  /** Pavilion steps from the girdle down: [inset, depth below girdle bottom]; the last one is the keel. */
  pavilion: [number, number][];
};

export const EMERALD_CUT: EmeraldCutParams = {
  ratio: 1.45,
  corner: 0.18,
  table: 0.62,
  girdle: 0.03,
  crown: [
    [0.19, 0.13],
    [0.125, 0.105],
    [0.06, 0.065],
    [0, 0],
  ],
  pavilion: [
    [0, 0],
    [0.12, 0.15],
    [0.27, 0.3],
    [0.5, 0.43],
  ],
};

type Vec = [number, number, number];

/** The octagon outline at a given inward offset, with 45° chamfers; points run around the y axis. */
export function ring(p: EmeraldCutParams, inset: number, y: number): Vec[] {
  const a = p.ratio / 2 - inset;
  const b = Math.max(0.5 - inset, 0);
  const c = Math.min(Math.max(p.corner - inset * (2 - Math.SQRT2), 0), b);
  return [
    [a - c, y, b],
    [-(a - c), y, b],
    [-a, y, b - c],
    [-a, y, -(b - c)],
    [-(a - c), y, -b],
    [a - c, y, -b],
    [a, y, -(b - c)],
    [a, y, b - c],
  ];
}

export function emeraldCutRings(p: EmeraldCutParams = EMERALD_CUT): Vec[][] {
  const top = p.girdle / 2;
  return [
    ...p.crown.map(([inset, h]) => ring(p, inset, top + h)),
    ...p.pavilion.map(([inset, d]) => ring(p, inset, -top - d)),
  ];
}

export function buildEmeraldCut(p: EmeraldCutParams = EMERALD_CUT): Float32Array {
  const rings = emeraldCutRings(p);
  const tris: Vec[] = [];
  const table = rings[0];
  const centre: Vec = [0, table[0][1], 0];
  for (let j = 0; j < 8; j++) tris.push(centre, table[j], table[(j + 1) % 8]);
  for (let i = 0; i < rings.length - 1; i++) {
    const [r, s] = [rings[i], rings[i + 1]];
    for (let j = 0; j < 8; j++) {
      const k = (j + 1) % 8;
      tris.push(r[j], s[j], s[k], r[j], s[k], r[k]);
    }
  }
  const out = new Float32Array(tris.flat());
  if (signedVolume(out) < 0) flipWinding(out);
  return out;
}

export function signedVolume(pos: Float32Array): number {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(i, i + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function flipWinding(pos: Float32Array) {
  for (let i = 0; i < pos.length; i += 9) {
    for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
  }
}
