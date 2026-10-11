"use client";

import { SceneSvg, along, at, bed, geo, hash, polyD, useFrame, type Frame, type Pt, type Scene, type Shape } from "./common";

/** Rows of blocks from the panel outwards: how many are kept, so the pile tapers like a hill. */
const ROWS = [1, 0.9, 0.62, 0.34, 0.14];

/**
 * E. Rising gem hill: chunky octagon blocks piled along the diagonal like a staircase, carved from the panel's own
 * colour with light from above: a lit top facet, mid sides, a dark underside. The form sits at the foot of the hill.
 */
export function sceneE(f: Frame): Scene {
  const g = geo(f);
  const u = (f.kind === "tall" ? 34 : 74) * (f.kind === "tall" ? 1 : g.k);
  const out: Scene = [{ body: polyD(bed(g, () => 0.25 * u, 24)) }];
  ROWS.forEach((keep, r) => {
    const o = (0.2 + r * 0.82) * u;
    const stagger = (r % 2) * 0.5;
    for (let s = -u + stagger * u; s < g.len + u; s += u * 0.98) {
      if (hash(Math.round(s), r, 4) > keep) continue;
      const [cx, cy] = at(g, s, o);
      if (along(g, cx, cy) < -u || cx < -u || cx > f.w + u || cy < -u || cy > f.h + u) continue;
      out.push(block(cx, cy, u * (r > 2 ? 0.9 : 1)));
    }
  });
  return out;
}

/** A cut block: octagon outline, a table, and eight bevels toned by direction (top lit, bottom dark). */
function block(cx: number, cy: number, size: number): Shape {
  const h = size / 2;
  const c = size * 0.3;
  const ring: Pt[] = [
    [cx - h + c, cy - h],
    [cx + h - c, cy - h],
    [cx + h, cy - h + c],
    [cx + h, cy + h - c],
    [cx + h - c, cy + h],
    [cx - h + c, cy + h],
    [cx - h, cy + h - c],
    [cx - h, cy - h + c],
  ];
  const t = size * 0.27;
  const table: Pt[] = [
    [cx - h + c + t * 0.4, cy - h + t],
    [cx + h - c - t * 0.4, cy - h + t],
    [cx + h - t, cy - h + c + t * 0.4],
    [cx + h - t, cy + h - c - t * 0.4],
    [cx + h - c - t * 0.4, cy + h - t],
    [cx - h + c + t * 0.4, cy + h - t],
    [cx - h + t, cy + h - c - t * 0.4],
    [cx - h + t, cy - h + c + t * 0.4],
  ];
  const tones: Shape["tones"] = [];
  const kinds = ["hi", "lighter", "shade", "deep", "lo", "deep", "light", "hi"] as const;
  for (let i = 0; i < 8; i++) tones.push({ d: polyD([ring[i], ring[(i + 1) % 8], table[(i + 1) % 8], table[i]]), tone: kinds[i] });
  // A little gloss on the table's upper left.
  tones.push({ d: polyD([table[0], table[1], table[7]]), tone: "lighter" });
  return { body: polyD(ring), tones };
}

export function VariantE() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneE(f)} /> : null;
}
