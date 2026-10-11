"use client";

import { SceneSvg, polyD, useFrame, type Frame, type Scene } from "./common";
import { chip, density, field, gemSize, ground, octagon, sites, threshold } from "./octa";

/**
 * A1. Halftone front: a regular grid of small octagons, packed and fused behind the front, then an even checker-like
 * spread of separate gems (smooth falloff past the diagonal, ordered dither), then sparse lone gems.
 */
export function sceneA1(f: Frame): Scene {
  const fl = field(f);
  let d = "";
  for (const s of sites(fl)) {
    const p = density(fl, s.d);
    if (p <= threshold(s.i, s.j)) continue;
    // Fused gems overlap a little; as they thin out they shrink so the gaps read.
    d += polyD(octagon(s.x, s.y, fl.pitch * gemSize(p))) + chip(fl, s.i, s.j);
  }
  return [ground(fl), { body: d }];
}

export function VariantA1() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneA1(f)} /> : null;
}
