import { along, bed, dist, geo, polyD, type Frame, type Geo, type Pt } from "./geo";

/**
 * The divider: small flat octagon gems in the panel's own colour and texture, growing from the panel into the footage as
 * connected clumps and fingers of fused gems, with a few breakaway gems ahead of the tips. The grid divides the 360px
 * texture tile (30px, 20px on a phone) and is centred on the texture's octagon centres, so the texture lines run along
 * the gem rows. The growth is deterministic: a seeded reach profile along the diagonal says how far each stretch may
 * grow, and only sites connected to the solid band count (Eden-like: ragged, gem-shaped tips).
 */
export const TILE_CENTRE = { x: 160, y: 140 };

/** 1 fingers, 2 clumps, 3 mixed. */
export type Tuning = 1 | 2 | 3;

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

type Bump = { c: number; w: number; a: number };

/** How far past the band each stretch of the diagonal may grow, px: a few seeded bumps over a small base. */
function reachProfile(fl: Field, tuning: Tuning): (s: number) => number {
  const { len } = fl.g;
  const u = fl.unit;
  const tall = fl.frame.kind === "tall";
  const bumps: Bump[] = [];
  const spread = (n: number, salt: number, width: (r: number) => number, amp: (r: number) => number) => {
    for (let k = 0; k < n; k++) {
      const r = hash(k, salt, 7);
      bumps.push({ c: (len * (k + 0.5 + (hash(k, salt, 8) - 0.5) * 0.5)) / n, w: width(r) * u, a: amp(r) * u });
    }
  };
  let base = 14;
  if (tuning === 1) {
    // Fewer, longer fingers: 5 to 7 across the diagonal.
    spread(tall ? 3 : 6, 1, (r) => 34 + r * 20, (r) => 115 + r * 70);
    base = 10;
  } else if (tuning === 2) {
    // Rounded lumps along the front, shorter reach.
    spread(tall ? 5 : 9, 2, (r) => 62 + r * 30, (r) => 40 + r * 55);
    base = 18;
  } else {
    // Lumps with a couple of longer fingers.
    spread(tall ? 4 : 7, 3, (r) => 56 + r * 26, (r) => 36 + r * 50);
    const fingers = tall ? [0.3, 0.72] : [0.22, 0.63];
    fingers.forEach((f, k) => bumps.push({ c: len * (f + (hash(k, 4, 9) - 0.5) * 0.08), w: 30 * u, a: (150 + hash(k, 5, 9) * 40) * u }));
    base = 14;
  }
  return (s) => {
    let r = base * u;
    for (const b of bumps) r = Math.max(r, b.a * Math.exp(-(((s - b.c) / b.w) ** 2)));
    return r;
  };
}

export type Site = { i: number; j: number; x: number; y: number; d: number; s: number };
/** 1 solid band, 2 grown (connected), 3 breakaway. */
export type Growth = { fl: Field; state: Map<number, 1 | 2 | 3>; sites: Site[]; at: (i: number, j: number) => 0 | 1 | 2 | 3 };

/** The grown layout for a frame: which lattice sites carry a gem and of which kind. */
export function growth(frame: Frame, tuning: Tuning = 1): Growth {
  const fl = field(frame);
  const { g, pitch, band } = fl;
  const profile = reachProfile(fl, tuning);
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
  const share = tuning === 2 ? 0.04 : tuning === 3 ? 0.08 : 0.06;
  const want = Math.max(tuning === 2 ? 2 : 3, Math.round(grown * share));
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
  return { fl, state, sites, at: (i, j) => state.get(key(i, j)) ?? 0 };
}

/** A regular octagon centred at cx, cy measuring `flats` across its flat sides. */
export function octagon(cx: number, cy: number, flats: number): Pt[] {
  const r = flats / 2 / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, k): Pt => [cx + r * Math.cos(Math.PI / 8 + (k * Math.PI) / 4), cy + r * Math.sin(Math.PI / 8 + (k * Math.PI) / 4)]);
}

/** The ground strip and every gem (as one path), for a frame of this size. Fused gems get the diamonds between them filled. */
export function dividerScene(frame: Frame, tuning: Tuning = 1): { ground: string; gems: string } {
  const gr = growth(frame, tuning);
  const { pitch } = gr.fl;
  const solid = (i: number, j: number) => {
    const s = gr.at(i, j);
    return s === 1 || s === 2;
  };
  let gems = "";
  const done = new Set<string>();
  for (const s of gr.sites) {
    const kind = gr.at(s.i, s.j);
    gems += polyD(octagon(s.x, s.y, pitch * (kind === 3 ? 0.86 : 1.04)));
    if (kind === 3) continue;
    // The four diamonds around this gem: filled where three or more of the four sites around them are fused.
    for (const [a, b] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const i = s.i + a;
      const j = s.j + b;
      const id = `${i},${j}`;
      if (done.has(id)) continue;
      done.add(id);
      if ([solid(i, j), solid(i + 1, j), solid(i, j + 1), solid(i + 1, j + 1)].filter(Boolean).length < 3) continue;
      const cx = TILE_CENTRE.x + (i + 0.5) * pitch;
      const cy = TILE_CENTRE.y + (j + 0.5) * pitch;
      const r = pitch * 0.2929 * 1.08;
      gems += polyD([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
    }
  }
  return { ground: polyD(bed(gr.fl.g, pitch * 0.2)), gems };
}
