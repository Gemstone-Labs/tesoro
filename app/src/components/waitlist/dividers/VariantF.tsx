"use client";

import { SceneSvg, useFrame, useReducedMotion } from "./common";
import { crystals } from "./crystals";

/**
 * F. Growing: B's crystals grow out of the panel on load, scaled up from their base over about 1.2 s and staggered, then
 * rest and breathe very slowly. Reduced motion draws them grown (the CSS only animates when motion is allowed).
 */
export function VariantF() {
  const f = useFrame();
  const calm = useReducedMotion();
  if (!f) return null;
  const { rock, crystals: cs } = crystals(f);
  return <SceneSvg frame={f} scene={[rock, ...cs]} grow={!calm} />;
}
