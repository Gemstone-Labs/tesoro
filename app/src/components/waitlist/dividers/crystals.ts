import { LIGHT, at, bed, geo, hash, polyD, type Frame, type Pt, type Scene, type Shape } from "./common";

/**
 * Crystal prisms growing out of the panel (variants B and F): hexagonal shards with a pointed or table end, varied
 * in length and width, fanned a little either side of the normal. Two or three facet planes in tones of the stone.
 */
export function crystals(f: Frame): { rock: Shape; crystals: (Shape & { ox: number; oy: number; delay: number })[] } {
  const g = geo(f);
  const list: { s: number; w: number; len: number; ang: number; pointed: boolean; z: number }[] = [];
  const unit = f.kind === "tall" ? 0.45 : g.k;
  let s = -120;
  let n = 0;
  while (s < g.len + 140) {
    const r = (a: number) => hash(n, a, 31);
    const w = (30 + r(1) * 62) * unit;
    // Longer towards the middle of the edge, shorter at the ends, never less than a stub.
    const t = Math.min(Math.max(s / g.len, 0), 1);
    const mid = 0.55 + 0.45 * Math.sin(Math.PI * t);
    const len = (70 + r(2) * 250 * mid) * unit;
    list.push({ s, w, len, ang: (r(3) - 0.5) * 0.9 - 0.12, pointed: r(4) > 0.35, z: r(5) });
    s += w * (0.55 + r(6) * 0.5);
    n++;
  }
  // Back to front: the tall ones first, so the short ones in front show their own facets.
  list.sort((a, b) => b.len - a.len);
  const rock: Shape = { body: polyD(bed(g, (p) => (14 + 26 * hash(Math.round(p / 36), 0, 7)) * unit, 28)) };
  const out = list.map((c, i) => {
    const base = at(g, c.s, -g.inset * 0.5);
    const dirx = g.nx * Math.cos(c.ang) - g.ny * Math.sin(c.ang);
    const diry = g.nx * Math.sin(c.ang) + g.ny * Math.cos(c.ang);
    const px = -diry;
    const py = dirx;
    // local (x across, y along) to the frame
    const P = (x: number, y: number): Pt => [base[0] + px * x + dirx * y, base[1] + py * x + diry * y];
    const hw = c.w / 2;
    const L = c.len + g.inset * 0.5;
    const sh = L * 0.78;
    const tip: Pt[] = c.pointed ? [P(0, L)] : [P(hw * 0.55, L), P(-hw * 0.55, L)];
    const body: Pt[] = [P(-hw, 0), P(hw, 0), P(hw, sh), ...tip, P(-hw, sh)];
    // The face looking towards the light is the lighter one.
    const leftLit = -px * LIGHT[0] + -py * LIGHT[1] > 0;
    const split = -hw * 0.15;
    const left: Pt[] = [P(-hw, 0), P(split, 0), P(split, c.pointed ? L * 0.96 : sh), P(-hw, sh)];
    const right: Pt[] = [P(split, 0), P(hw, 0), P(hw, sh), ...(c.pointed ? [P(0, L)] : [P(hw * 0.55, L)]), P(split, c.pointed ? L : sh)].slice(0, c.pointed ? 5 : 5);
    const cap: Pt[] = c.pointed ? [P(-hw, sh), P(split, L * 0.96), P(0, L), P(hw, sh), P(split, sh)] : [P(-hw, sh), P(-hw * 0.55, L), P(hw * 0.55, L), P(hw, sh)];
    const tones = [
      { d: polyD(left), tone: leftLit ? ("light" as const) : ("shade" as const) },
      { d: polyD(right), tone: leftLit ? ("shade" as const) : ("light" as const) },
      { d: polyD(cap), tone: "lighter" as const },
    ];
    return { body: polyD(body), tones, ox: base[0], oy: base[1], delay: 0.15 + (i % 11) * 0.09 + (c.s / g.len) * 0.5 };
  });
  return { rock, crystals: out };
}

export function sceneCrystals(f: Frame): Scene {
  const { rock, crystals: cs } = crystals(f);
  return [rock, ...cs];
}
