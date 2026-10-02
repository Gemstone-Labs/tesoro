"use client";

import { MeshRefractionMaterial } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buildEmeraldCut } from "./emeraldCut";
import { studioEnvironment } from "./envTexture";

/** The cut Gema: refraction over the studio environment plus faint facet edges. Long axis x, table +y, width 1. */
export function GemMesh({ color = "#62f9d4" }: { color?: string }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buildEmeraldCut(), 3));
    g.computeVertexNormals();
    return g;
  }, []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 1), [geometry]);
  const env = useMemo(() => studioEnvironment(), []);
  useEffect(() => () => (geometry.dispose(), edges.dispose(), env.dispose()), [geometry, edges, env]);
  return (
    <group>
      <mesh geometry={geometry}>
        <MeshRefractionMaterial envMap={env} color={color} ior={2.0} bounces={3} fresnel={0.9} aberrationStrength={0} toneMapped={false} />
      </mesh>
      <lineSegments geometry={edges} scale={1.003}>
        <lineBasicMaterial color="#c8fdee" transparent opacity={0.35} depthWrite={false} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/** A soft radial glow texture for light pools and halos. `rgb` as "r,g,b"; fades to the same colour at zero alpha (no grey fringe). */
export function glowTexture(rgb: string, alpha: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, `rgba(${rgb},${alpha})`);
  r.addColorStop(0.5, `rgba(${rgb},${alpha * 0.35})`);
  r.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
