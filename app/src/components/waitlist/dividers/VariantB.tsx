"use client";

import { SceneSvg, useFrame } from "./common";
import { sceneCrystals } from "./crystals";

/** B. Crystal cluster: gem prisms jut out of the panel towards the top right, like a geode. */
export function VariantB() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneCrystals(f)} /> : null;
}
