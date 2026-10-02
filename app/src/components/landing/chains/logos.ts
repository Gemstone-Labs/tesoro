import * as THREE from "three";
import type { ChainLabel } from "./layout";

type P3 = [number, number, number];

/** A flat mark cut like a stone: extruded with one chamfer, so every edge becomes a facet. Curves are kept coarse on purpose. */
function cutStone(shapes: THREE.Shape[]): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: 0.06,
    bevelThickness: 0.06,
    bevelSize: 0.045,
    bevelOffset: -0.045,
    bevelSegments: 1,
    curveSegments: 7,
  });
  g.clearGroups(); // one BVH root: the refraction material cannot trace a grouped geometry
  g.center();
  g.computeVertexNormals();
  return g;
}

const SOL_RAMP = ["#14f195", "#5497d5", "#9945ff"].map((c) => new THREE.Color(c));

/** Solana: three leaning bars, with the mark's gradient (green top right to purple bottom left) as vertex colours. */
function solLogo(): THREE.BufferGeometry {
  const [w, h, lean] = [397.7, 77.6, 68];
  const k = 0.95 / w;
  const bar = (y: number, right: boolean) => {
    const [top, bottom] = right ? [lean, 0] : [0, lean];
    const outline = [
      [top, y],
      [w - lean + top, y],
      [w - lean + bottom, y + h],
      [bottom, y + h],
    ];
    return new THREE.Shape(outline.map(([x, v]) => new THREE.Vector2((x - w / 2) * k, (155.85 - v) * k)));
  };
  const g = cutStone([bar(0, true), bar(116.3, false), bar(234.1, true)]);
  const pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(0.5 - (pos.getX(i) * 0.46 + pos.getY(i) * 0.89) / 0.9, 0, 1) * 2;
    (t < 1 ? c.lerpColors(SOL_RAMP[0], SOL_RAMP[1], t) : c.lerpColors(SOL_RAMP[1], SOL_RAMP[2], t - 1)).toArray(colors, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Triangles wound to face away from a point inside the solid. */
function solid(inside: P3, tris: [P3, P3, P3][]): number[] {
  const core = new THREE.Vector3(...inside);
  return tris.flatMap(([p, q, r]) => {
    const [a, b, c] = [p, q, r].map((v) => new THREE.Vector3(...v));
    const outward = b.clone().sub(a).cross(c.clone().sub(a)).dot(a.clone().sub(core)) > 0;
    return (outward ? [p, q, r] : [p, r, q]).flat();
  });
}

/** Ethereum: the mark is already a stone. The upper octahedron and the lower chevron, matching the logo seen from the front. */
function ethLogo(): THREE.BufferGeometry {
  const k = 1.2 / 1277.39;
  const w = 392.07 * k;
  const d = w * 0.7;
  const y = (v: number) => (638.7 - v) * k;
  const [T, L, R, F, B, K]: P3[] = [[0, y(0), 0], [-w, y(650.54), 0], [w, y(650.54), 0], [0, y(472.33), d], [0, y(472.33), -d], [0, y(882.29), 0]];
  const [l, r, nf, nb, a]: P3[] = [[-w, y(724.89), 0], [w, y(724.89), 0], [0, y(956.52), d], [0, y(956.52), -d], [0, y(1277.38), 0]];
  const positions = [
    ...solid([0, y(600), 0], [[T, L, F], [T, F, R], [T, R, B], [T, B, L], [K, F, L], [K, R, F], [K, B, R], [K, L, B]]),
    ...solid([0, y(1050), 0], [[l, nf, a], [nf, r, a], [r, nb, a], [nb, l, a], [l, nb, nf], [r, nf, nb]]),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.computeVertexNormals();
  return g;
}

/** The Hyperliquid mark's outline (viewBox 144): a start point, then cubic segments as [c1, c2, end]. */
const HYPE_START = [144, 71.6991];
const HYPE_CUBICS = [
  [144, 119.306, 114.866, 134.582, 99.5156, 120.98],
  [86.8804, 109.889, 83.1211, 86.4521, 64.116, 84.0456],
  [39.9942, 81.0113, 37.9057, 113.133, 22.0334, 113.133],
  [3.5504, 113.133, 0, 86.2428, 0, 72.4315],
  [0, 58.3063, 3.96809, 39.0542, 19.736, 39.0542],
  [38.1146, 39.0542, 39.1588, 66.5722, 62.132, 65.1073],
  [85.0007, 63.5379, 85.4184, 34.8689, 100.247, 22.6271],
  [113.195, 12.0593, 144, 23.4641, 144, 71.6991],
];

function hypeLogo(): THREE.BufferGeometry {
  const k = 0.95 / 144;
  const at = (x: number, v: number) => [(x - 72) * k, (72 - v) * k] as const;
  const shape = new THREE.Shape();
  shape.moveTo(...at(HYPE_START[0], HYPE_START[1]));
  for (const [x1, y1, x2, y2, x, v] of HYPE_CUBICS) shape.bezierCurveTo(...at(x1, y1), ...at(x2, y2), ...at(x, v));
  return cutStone([shape]);
}

/** Each chain's mark as one flat-faceted geometry, about one unit across and centred on the origin. */
export const chainLogo: Record<ChainLabel, () => THREE.BufferGeometry> = { SOL: solLogo, ETH: ethLogo, HYPE: hypeLogo };
