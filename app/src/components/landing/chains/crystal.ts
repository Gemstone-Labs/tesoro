import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** A seeded 0..1 sequence so each cluster is irregular but identical on every render. */
function seq(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** One natural crystal: a slightly tapered hexagonal prism with a pyramidal termination. */
function prism(h: number, r: number, tip: number, twist: number) {
  const body = new THREE.CylinderGeometry(r * 0.92, r, h, 6, 1, true);
  body.translate(0, h / 2, 0);
  const cap = new THREE.ConeGeometry(r * 0.92, tip, 6, 1, true);
  cap.translate(0, h + tip / 2, 0);
  const g = mergeGeometries([body.toNonIndexed(), cap.toNonIndexed()])!;
  g.rotateY(twist);
  return g;
}

/** A raw emerald cluster as one flat-faceted geometry, grown out of a common root. */
export function crystalCluster(seed: number): THREE.BufferGeometry {
  const r = seq(seed);
  const parts: THREE.BufferGeometry[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    const main = i === 0;
    const h = main ? 0.78 : 0.3 + r() * 0.4;
    const rad = main ? 0.15 : 0.06 + r() * 0.07;
    const g = prism(h, rad, rad * (1.6 + r() * 0.8), r() * Math.PI);
    if (!main) {
      const a = (i / (count - 1)) * Math.PI * 2 + r() * 0.5;
      g.rotateZ((0.25 + r() * 0.35) * Math.cos(a));
      g.rotateX((0.25 + r() * 0.35) * Math.sin(a));
      g.translate(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12);
    }
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  merged.translate(0, -0.5, 0);
  merged.computeVertexNormals();
  return merged;
}
