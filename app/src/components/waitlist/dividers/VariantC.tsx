"use client";

import { LIGHT, SceneSvg, at, geo, hash, polyD, useFrame, type Frame, type Piece, type Pt, type Scene } from "./common";

/**
 * C. Faceted cut edge: the panel is one big cut stone. Its edge is a girdle of large angled facets (a polygon whose
 * vertices step in and out along the diagonal) with a crown of triangular facets inside it, toned by how they face the
 * light, and flat further in.
 */
export function sceneC(f: Frame): Scene {
  const g = geo(f);
  const unit = f.kind === "tall" ? 0.5 : g.k;
  const stepLen = 230 * unit;
  const n = Math.ceil((g.len + 520) / stepLen);
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const s = -260 + k * stepLen * (0.85 + 0.3 * hash(k, 1, 3));
    // Girdle: alternating high points and notches, so the edge reads as big facets.
    const high = k % 2 === 0;
    outer.push(at(g, s, ((high ? 150 : 52) + hash(k, 2, 3) * 70) * unit));
    inner.push(at(g, s + stepLen * 0.5, (high ? -20 : 20) * unit));
  }
  const body = polyD([at(g, -300, -g.inset - 40), ...outer, at(g, g.len + 400, -g.inset - 40)]);
  const tones: Piece[] = [];
  for (let k = 0; k < outer.length - 1; k++) {
    const o0 = outer[k];
    const o1 = outer[k + 1];
    const i0 = inner[k];
    const i1 = inner[k + 1];
    // Crown triangles: each edge of the girdle has its facet; shading from the edge's normal against the light.
    const ex = o1[0] - o0[0];
    const ey = o1[1] - o0[1];
    const l = Math.hypot(ex, ey) || 1;
    const nrm: Pt = [ey / l, -ex / l]; // towards the footage
    const dot = nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1];
    tones.push({ d: polyD([i0, o0, o1]), tone: dot > 0.25 ? "lighter" : dot > -0.2 ? "light" : "shade" });
    const ex2 = i1[0] - o1[0];
    const ey2 = i1[1] - o1[1];
    const l2 = Math.hypot(ex2, ey2) || 1;
    const dot2 = (ey2 / l2) * LIGHT[0] + (-ex2 / l2) * LIGHT[1];
    tones.push({ d: polyD([o1, i1, i0]), tone: dot2 > 0 ? "light" : "shade" });
    if (k < outer.length - 2) tones.push({ d: polyD([i1, o1, outer[k + 2]]), tone: hash(k, 9, 3) > 0.5 ? "deep" : "shade" });
  }
  return [{ body, tones }];
}

export function VariantC() {
  const f = useFrame();
  return f ? <SceneSvg frame={f} scene={sceneC(f)} /> : null;
}
