"use client";

import { MeshRefractionMaterial, PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { buildEmeraldCut } from "./emeraldCut";
import { studioEnvironment } from "./envTexture";
import { gemState } from "./store";

/** Orientation per Gemas beat: the rest pose (30° above the table, 35° turned), the crown steps, the pavilion. */
const BEATS = [new THREE.Euler(0.52, 0.61, 0), new THREE.Euler(0.3, 1.75, 0.1), new THREE.Euler(-0.32, 2.9, -0.08)];
const IDLE_YAW = 0.12;
const TILT = 0.14;

function Gem({ tilt, animate }: { tilt: boolean; animate: boolean }) {
  const mesh = useRef<THREE.Group>(null);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buildEmeraldCut(), 3));
    g.computeVertexNormals();
    return g;
  }, []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 1), [geometry]);
  const env = useMemo(() => studioEnvironment(), []);
  useEffect(() => () => (geometry.dispose(), edges.dispose(), env.dispose()), [geometry, edges, env]);

  const target = useMemo(() => new THREE.Quaternion(), []);
  const euler = useMemo(() => new THREE.Euler(), []);
  const yaw = useRef(0);
  useLayoutEffect(() => void mesh.current?.quaternion.setFromEuler(BEATS[0]), []);

  useFrame((_, delta) => {
    const m = mesh.current;
    if (!m) return;
    if (animate) yaw.current += delta * IDLE_YAW;
    const b = BEATS[gemState.beat] ?? BEATS[0];
    const px = tilt ? gemState.pointer.x * TILT : 0;
    const py = tilt ? gemState.pointer.y * TILT : 0;
    euler.set(b.x + py, b.y + yaw.current + px, b.z);
    target.setFromEuler(euler);
    if (animate) m.quaternion.slerp(target, 1 - Math.exp(-delta * 4));
    else m.quaternion.copy(target);
  });

  return (
    <group ref={mesh}>
      <mesh geometry={geometry}>
        <MeshRefractionMaterial envMap={env} color="#62f9d4" ior={2.0} bounces={3} fresnel={0.9} aberrationStrength={0} toneMapped={false} />
      </mesh>
      <lineSegments geometry={edges} scale={1.003}>
        <lineBasicMaterial color="#c8fdee" transparent opacity={0.35} depthWrite={false} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/** The live 3D Gema. `active` false stops rendering (off screen); `still` renders the rest pose only (poster capture). */
export default function GemCanvas({ active, still = false, onReady }: { active: boolean; still?: boolean; onReady?: () => void }) {
  const [dpr, setDpr] = useState(1.75);
  const [tilt, setTilt] = useState(!still);
  const frames = useRef(0);
  return (
    <Canvas
      frameloop={still ? "demand" : active ? "always" : "never"}
      dpr={[1, dpr]}
      camera={{ position: [0, 0, 4.4], fov: 30 }}
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: still }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      aria-hidden
    >
      <PerformanceMonitor onDecline={() => (dpr > 1 ? setDpr(1) : setTilt(false))} />
      <Gem tilt={tilt} animate={!still} />
      <FirstFrame onFrame={() => frames.current++ === (still ? 0 : 1) && onReady?.()} />
    </Canvas>
  );
}

function FirstFrame({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}
