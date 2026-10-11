"use client";

import { TILE_CENTRE } from "../dissolve";
import { SceneSvg, along, bed, dist, geo, hash, octPts, polyD, useFrame, type Frame, type Scene } from "./common";

/** Tiers of texture octagons, big to small: scale against the texture's 260x200 octagon, lattice pitch (divides 360), reach px. */
const TIERS = {
  wide: [
    { scale: 1, pitch: 180, reach: 120, keep: 0.8 },
    { scale: 0.5, pitch: 90, reach: 300, keep: 0.5 },
    { scale: 0.25, pitch: 45, reach: 450, keep: 0.3 },
  ],
  tall: [
    { scale: 0.5, pitch: 180, reach: 90, keep: 0.9 },
    { scale: 0.25, pitch: 90, reach: 170, keep: 0.6 },
    { scale: 0.125, pitch: 45, reach: 230, keep: 0.34 },
  ],
} as const;

/**
 * A. Stepped octagon growth: the panel's edge is a staircase of solid octagon blocks on the texture's own grid (the
 * biggest are the texture's octagon, so its lines run through them), fused to the panel and to each other, smaller
 * and fewer the further they climb.
 */
export function sceneA(f: Frame): Scene {
  const g = geo(f);
  const shapes: { x: number; y: number; r: number; s: number }[] = [];
  const out: Scene = [{ body: polyD(bed(g, () => 18 * g.k)) }];
  TIERS[f.kind].forEach((tier, ti) => {
    const r = 120 * tier.scale; // roughly the octagon's reach
    const i0 = Math.floor((-TILE_CENTRE.x - tier.pitch) / tier.pitch);
    const j0 = Math.floor((-TILE_CENTRE.y - tier.pitch) / tier.pitch);
    const added: typeof shapes = [];
    for (let i = i0; TILE_CENTRE.x + i * tier.pitch < f.w + tier.pitch; i++) {
      for (let j = j0; TILE_CENTRE.y + j * tier.pitch < f.h + tier.pitch; j++) {
        const x = TILE_CENTRE.x + i * tier.pitch;
        const y = TILE_CENTRE.y + j * tier.pitch;
        const d = dist(g, x, y);
        const s = along(g, x, y);
        if (d < -g.inset * 0.3 || d > tier.reach || s < -r || s > g.len + r) continue;
        const t = Math.max(d, 0) / tier.reach;
        if (hash(i, j, ti + 11) > tier.keep * (1 - 0.55 * t)) continue;
        // Fused: it must reach the panel or an octagon already placed.
        const fused = d <= r * 0.7 || shapes.some((o) => Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.62);
        if (!fused) continue;
        added.push({ x, y, r, s: tier.scale });
      }
    }
    shapes.push(...added);
  });
  // Small ones last so they sit on top of the big ones' edges.
  for (const o of shapes) out.push({ body: polyD(octPts(o.x, o.y, o.s)) });
  return out;
}

export function VariantA() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneA(f)} /> : null;
}
