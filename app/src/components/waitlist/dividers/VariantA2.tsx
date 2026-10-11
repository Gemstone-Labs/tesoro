"use client";

import { SceneSvg, polyD, useFrame, type Frame, type Pt, type Scene } from "./common";
import { density, field, ground, octagon, sites, threshold } from "./octa";

/**
 * A2. Octagon-square tiling (the 4.8.8 pattern): small octagons with the little square chips between them, all filled behind
 * the front, so it is solid and fused. At the front the chips drop out first, then the octagons drop out by falloff and dither,
 * leaving separate gems that thin to a few.
 */
export function sceneA2(f: Frame): Scene {
  const fl = field(f);
  const L = fl.pitch;
  const chipEdge = fl.packed + (fl.reach - fl.packed) * 0.2;
  let oct = "";
  for (const s of sites(fl)) {
    if (s.d <= chipEdge) oct += polyD(octagon(s.x, s.y, L * 1.01));
    else if (density(fl, s.d, chipEdge) > threshold(s.i, s.j)) oct += polyD(octagon(s.x, s.y, L * 0.84));
  }
  // The chips: diamonds on the lattice's dual points, filling the corners between four octagons.
  const h = L / 2;
  const r = L * 0.2929 * 1.04;
  let chips = "";
  for (const s of sites(fl)) {
    const cx = s.x + h;
    const cy = s.y + h;
    if (s.d + h * 0.2 > chipEdge) continue;
    const dia: Pt[] = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
    chips += polyD(dia);
  }
  return [ground(fl), { body: chips + oct }];
}

export function VariantA2() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneA2(f)} /> : null;
}
