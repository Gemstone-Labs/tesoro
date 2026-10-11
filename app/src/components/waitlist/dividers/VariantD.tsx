"use client";

import { TILE_CENTRE } from "../dissolve";
import { SceneSvg, along, bed, dist, geo, hash, octPts, polyD, useFrame, type Frame, type Scene } from "./common";

/**
 * D. Texture filling in: the texture's own 360px octagons turn solid along the diagonal. Next to the panel they overlap
 * (a half-step lattice) and merge into it, then the plain lattice with gaps, then single octagons that shrink as they
 * thin out. Nothing is outlined beyond what the texture draws.
 */
export function sceneD(f: Frame): Scene {
  const g = geo(f);
  const kk = f.kind === "tall" ? 0.5 : 1;
  const out: Scene = [{ body: polyD(bed(g, () => 6 * g.k)) }];
  const reach = f.kind === "tall" ? 260 : 600 * Math.min(Math.max(f.w / 1440, 0.9), 1.2);
  const merge = reach * 0.3;
  const pitch = 360 * kk;
  const row = pitch / 2;
  // Rows every half pitch; odd rows shifted half a pitch, so the octagons interlock like a honeycomb.
  for (let j = -3; TILE_CENTRE.y + j * row < f.h + 400; j++) {
    const shift = j % 2 ? pitch / 2 : 0;
    for (let i = -3; TILE_CENTRE.x + i * pitch + shift < f.w + 400; i++) {
      const x = TILE_CENTRE.x + i * pitch + shift;
      const y = TILE_CENTRE.y + j * row;
      const d = dist(g, x, y);
      const s = along(g, x, y);
      if (d < -g.inset * 0.3 || d > reach || s < -200 || s > g.len + 200) continue;
      const texture = j % 2 === 0; // the texture's own octagons (the others sit between them)
      const t = Math.max(d, 0) / reach;
      if (d <= merge) place(out, x, y, 1, kk);
      else if (texture && hash(i, j, 5) < 0.92 - 0.82 * t) place(out, x, y, Math.max(1 - 0.55 * t, 0.45), kk);
    }
  }
  return out;
}

const place = (out: Scene, cx: number, cy: number, scale: number, kk: number) => out.push({ body: polyD(octPts(cx, cy, scale * kk)) });

export function VariantD() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneD(f)} /> : null;
}
