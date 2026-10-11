"use client";

import { SceneSvg, hash, polyD, useFrame, type Frame, type Scene, type Shape } from "./common";
import { FUSED, chip, density, field, gemSize, ground, octagon, sites, threshold } from "./octa";

/** Seconds the front takes to reach its full extent. */
const ADVANCE = 26;

/**
 * A4. Consuming: A1's pattern, but the front advances slowly. The fused gems (the solid zone) are there from the start; the rest pop in
 * (scale 0 to 1, staggered) outward from the panel over about 26 s, then hold. Reduced motion draws the final state.
 */
export function sceneA4(f: Frame): Scene {
  const fl = field(f);
  let packed = "";
  const popping: Shape[] = [];
  for (const s of sites(fl)) {
    const p = density(fl, s.d);
    if (p <= threshold(s.i, s.j)) continue;
    if (p >= FUSED) {
      packed += polyD(octagon(s.x, s.y, fl.pitch * gemSize(p))) + chip(fl, s.i, s.j);
      continue;
    }
    const t = (s.d - fl.packed) / (fl.reach - fl.packed);
    popping.push({ body: polyD(octagon(s.x, s.y, fl.pitch * gemSize(p))), ox: s.x, oy: s.y, delay: 1 + t * ADVANCE + hash(s.i, s.j, 4) * 1.4 });
  }
  return [ground(fl), { body: packed }, ...popping];
}

export function VariantA4() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneA4(f)} grow /> : null;
}
