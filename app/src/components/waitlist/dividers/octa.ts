import { along, bed, dist, geo, polyD, type Frame, type Geo, type Pt } from "./geo";

/**
 * The divider: small flat octagon gems in the panel's own colour and texture, growing from the panel into the footage as
 * connected clumps and fingers of fused gems, with a few breakaway gems ahead of the tips. The grid divides the 360px
 * texture tile (30px, 20px on a phone) and is centred on the texture's octagon centres, so the texture lines run along
 * the gem rows. The growth is deterministic: a seeded reach profile along the diagonal says how far each stretch may
 * grow, and only sites connected to the solid band count (Eden-like: ragged, gem-shaped tips).
 */
export const TILE_CENTRE = { x: 160, y: 140 };

export type Field = { g: Geo; frame: Frame; pitch: number; /** solid band, px past the diagonal */ band: number; /** size factor against 1440 wide */ unit: number };

export function field(frame: Frame): Field {
  const g = geo(frame);
  const tall = frame.kind === "tall";
  return { g, frame, pitch: tall ? 20 : 30, band: tall ? 32 : 76, unit: tall ? 0.42 : Math.min(Math.max(frame.w / 1440, 0.85), 1.1) };
}

/** A stable 0..1 per (a, b, salt). */
export function hash(a: number, b: number, salt = 0) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}


/** How far past the band each stretch of the diagonal may grow, px: 5 to 7 long fingers (6 on desktop, 3 on a phone) over a small base. */
function reachProfile(fl: Field): (s: number) => number {
  const { len } = fl.g;
  const u = fl.unit;
  const n = fl.frame.kind === "tall" ? 3 : 6;
  const bumps: { c: number; w: number; a: number }[] = [];
  for (let k = 0; k < n; k++) {
    const r = hash(k, 1, 7);
    bumps.push({ c: (len * (k + 0.5 + (hash(k, 1, 8) - 0.5) * 0.5)) / n, w: (34 + r * 20) * u, a: (115 + r * 70) * u });
  }
  return (s) => {
    let r = 10 * u;
    for (const b of bumps) r = Math.max(r, b.a * Math.exp(-(((s - b.c) / b.w) ** 2)));
    return r;
  };
}

export type Site = { i: number; j: number; x: number; y: number; d: number; s: number };
/** 1 solid band, 2 grown (connected), 3 breakaway. */
export type Growth = { fl: Field; state: Map<number, 1 | 2 | 3>; sites: Site[]; at: (i: number, j: number) => 0 | 1 | 2 | 3; /** how far the growth may reach past the band at this position along the diagonal */ reachAt: (s: number) => number };

/** The grown layout for a frame: which lattice sites carry a gem and of which kind. */
export function growth(frame: Frame): Growth {
  const fl = field(frame);
  const { g, pitch, band } = fl;
  const profile = reachProfile(fl);
  const i0 = Math.floor((-TILE_CENTRE.x - pitch) / pitch);
  const j0 = Math.floor((-TILE_CENTRE.y - pitch) / pitch);
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  const sites: Site[] = [];
  const candidate = new Map<number, Site>();
  const state = new Map<number, 1 | 2 | 3>();
  for (let i = i0; TILE_CENTRE.x + i * pitch < frame.w + pitch; i++) {
    for (let j = j0; TILE_CENTRE.y + j * pitch < frame.h + pitch; j++) {
      const x = TILE_CENTRE.x + i * pitch;
      const y = TILE_CENTRE.y + j * pitch;
      const d = dist(g, x, y);
      const s = along(g, x, y);
      if (d < -g.inset * 0.5 || s < -pitch * 2 || s > g.len + pitch * 2) continue;
      const site = { i, j, x, y, d, s };
      if (d <= band) {
        state.set(key(i, j), 1);
        sites.push(site);
      } else if (d - band <= profile(s) * (0.78 + 0.42 * hash(i, j, 11))) {
        candidate.set(key(i, j), site);
      }
    }
  }
  // Keep only what is connected to the band, orthogonal neighbours (octagons share an edge): Eden-like growth.
  const queue = sites.filter((s) => s.d > band - pitch * 1.6);
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    for (const [di, dj] of NB) {
      const k = key(c.i + di, c.j + dj);
      const n = candidate.get(k);
      if (!n || state.has(k)) continue;
      state.set(k, 2);
      sites.push(n);
      queue.push(n);
    }
  }
  // Breakaway gems: a few, one empty cell beyond a clump tip, never touching one.
  const grown = sites.filter((s) => state.get(key(s.i, s.j)) === 2).length;
  const want = Math.max(3, Math.round(grown * 0.06));
  const near = new Set<number>();
  const taken = (i: number, j: number) => state.has(key(i, j));
  const fused = sites.filter((s) => s.d > band + pitch);
  const picks: { site: Site; h: number }[] = [];
  for (const f of fused) {
    for (const [di, dj] of NB) {
      const i = f.i + di * 2;
      const j = f.j + dj * 2;
      const k = key(i, j);
      if (near.has(k) || taken(i, j)) continue;
      near.add(k);
      // No fused neighbour, so it stands apart.
      if ([-1, 0, 1].some((a) => [-1, 0, 1].some((b) => taken(i + a, j + b)))) continue;
      const x = TILE_CENTRE.x + i * pitch;
      const y = TILE_CENTRE.y + j * pitch;
      const d = dist(g, x, y);
      if (d <= band + pitch * 1.5) continue;
      picks.push({ site: { i, j, x, y, d, s: along(g, x, y) }, h: hash(i, j, 13) });
    }
  }
  picks.sort((a, b) => a.h - b.h);
  for (const p of picks.slice(0, want)) {
    state.set(key(p.site.i, p.site.j), 3);
    sites.push(p.site);
  }
  return { fl, state, sites, at: (i, j) => state.get(key(i, j)) ?? 0, reachAt: profile };
}

/** A regular octagon centred at cx, cy measuring `flats` across its flat sides. */
export function octagon(cx: number, cy: number, flats: number): Pt[] {
  const r = flats / 2 / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, k): Pt => [cx + r * Math.cos(Math.PI / 8 + (k * Math.PI) / 4), cy + r * Math.sin(Math.PI / 8 + (k * Math.PI) / 4)]);
}

/** Gem size (share of its cell) at the finger tips; the band and the foot of a finger are fused (1). */
const TIP = 0.72;

/** A grown gem's size as a share of its cell: `along` is how far out it is on its finger (0 at the band, 1 at the tip). Gaps open as the fingers grow out. */
export function gemSize(along: number): number {
  return 1 - (1 - TIP) * Math.min(Math.max(along, 0), 1);
}

/** The ground strip and every gem (as one path), for a frame of this size. The band is fused (diamonds between its gems filled); the growth zone keeps a gap between gems. */
export function dividerScene(frame: Frame): { ground: string; gems: string } {
  const gr = growth(frame);
  const { pitch, band } = gr.fl;
  // Size share per fused site: the band is solid, grown gems shrink towards the tips.
  const size = (s: Site, kind: number) => (kind === 1 ? 1.04 : kind === 3 ? 0.86 : gemSize((s.d - band) / Math.max(gr.reachAt(s.s), 1)));
  const bySite = new Map<string, { kind: number; size: number }>();
  for (const s of gr.sites) {
    const kind = gr.at(s.i, s.j);
    bySite.set(`${s.i},${s.j}`, { kind, size: size(s, kind) });
  }
  let gems = "";
  const done = new Set<string>();
  for (const s of gr.sites) {
    const me = bySite.get(`${s.i},${s.j}`)!;
    gems += polyD(octagon(s.x, s.y, pitch * me.size));
    if (me.kind === 3) continue;
    // The four diamonds around this gem: filled where three or more of the sites around them are in the band, or are
    // fused gems that still fill their cell.
    for (const [a, b] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const i = s.i + a;
      const j = s.j + b;
      const id = `${i},${j}`;
      if (done.has(id)) continue;
      done.add(id);
      const around = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([x, y]) => bySite.get(`${x},${y}`));
      const inBand = around.filter((c) => c?.kind === 1).length;
      const full = around.filter((c) => c && c.kind !== 3 && c.size >= 0.97).length;
      if (inBand < 3 && full < 3) continue;
      const cx = TILE_CENTRE.x + (i + 0.5) * pitch;
      const cy = TILE_CENTRE.y + (j + 0.5) * pitch;
      const r = pitch * 0.2929 * 1.08;
      gems += polyD([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
    }
  }
  return { ground: polyD(bed(gr.fl.g, pitch * 0.2)), gems };
}
