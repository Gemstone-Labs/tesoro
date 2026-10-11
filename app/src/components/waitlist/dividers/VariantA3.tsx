"use client";

import { SceneSvg, polyD, useFrame, type Frame, type Scene } from "./common";
import { dist } from "./common";
import { field, ground, octagon, sites } from "./octa";

/**
 * A3. Size halftone: every grid cell has a gem, and its size shrinks with the distance past the diagonal: overlapping and fused
 * next to the panel, then separate shrinking gems, then tiny specks, then nothing.
 */
export function sceneA3(f: Frame): Scene {
  const fl = field(f);
  const share = (d: number) => {
    const t = d <= fl.packed ? 0 : Math.min((d - fl.packed) / (fl.reach - fl.packed), 1);
    return fl.pitch * 1.18 * (1 - t * t * (3 - 2 * t)) ** 1.1;
  };
  let d = "";
  for (const s of sites(fl)) {
    const size = share(s.d);
    if (size < fl.pitch * 0.17) continue;
    d += polyD(octagon(s.x, s.y, size));
    // Corner diamonds while the gems still overlap, so the packed zone has no holes.
    if (size >= fl.pitch * 1.04) {
      const h = fl.pitch / 2;
      const r = fl.pitch * 0.2929 * 1.1;
      const cx = s.x + h;
      const cy = s.y + h;
      if (share(dist(fl.g, cx, cy)) >= fl.pitch * 1.04) d += polyD([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
    }
  }
  return [ground(fl), { body: d }];
}

export function VariantA3() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneA3(f)} /> : null;
}
