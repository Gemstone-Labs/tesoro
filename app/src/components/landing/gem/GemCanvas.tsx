"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { LiveCanvasProps } from "../Stage3D";
import { GemMesh, glowTexture } from "./GemMesh";
import { gemState } from "./store";

/** Tilt per Gemas beat while the gem spins: table on, crown steps, pavilion. */
const BEAT_TILT = [0, 0.22, -0.38];
const SPIN = 0.55;
const TILT = 0.12;
/** The rest pose for the poster: table almost facing the viewer. */
const REST_YAW = -0.45;

/** The Gema standing on its end on an octagonal plinth, spinning. */
function Showcase({ tilt, animate }: { tilt: boolean; animate: boolean }) {
  const spin = useRef<THREE.Group>(null);
  const lean = useRef<THREE.Group>(null);
  const yaw = useRef(REST_YAW);
  const time = useRef(0);
  const pool = useMemo(() => glowTexture("54,240,190", 0.42), []);
  const steel = useMemo(() => new THREE.MeshStandardMaterial({ color: "#1b252b", metalness: 0.8, roughness: 0.42 }), []);
  /** The plinth's top edge, an emerald octagon line. */
  const rim = useMemo(() => {
    const pts = Array.from({ length: 8 }, (_, i) => {
      const a = (Math.PI / 4) * i;
      return new THREE.Vector3(Math.sin(a) * 0.62, 0, Math.cos(a) * 0.62);
    });
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);
  useEffect(() => () => (pool.dispose(), steel.dispose(), rim.dispose()), [pool, steel, rim]);

  useFrame((_, delta) => {
    if (!spin.current || !lean.current) return;
    if (animate) {
      yaw.current += delta * SPIN;
      time.current += delta;
    }
    spin.current.rotation.y = yaw.current + (tilt ? gemState.pointer.x * TILT : 0);
    spin.current.position.y = animate ? Math.sin(time.current * 1.2) * 0.03 : 0;
    const target = (BEAT_TILT[gemState.beat] ?? 0) + (tilt ? gemState.pointer.y * TILT : 0);
    lean.current.rotation.x += animate ? (target - lean.current.rotation.x) * (1 - Math.exp(-delta * 3)) : target - lean.current.rotation.x;
  });

  return (
    <group position={[0, 0.12, 0]}>
      <group ref={lean}>
        <group ref={spin}>
          {/* long axis up, table towards the viewer */}
          <group rotation={[0, Math.PI / 2, 0]}>
            <group rotation={[0, 0, Math.PI / 2]}>
              <GemMesh />
            </group>
          </group>
        </group>
      </group>
      <group position={[0, -1.02, 0]}>
        <mesh material={steel} position={[0, -0.13, 0]}>
          <cylinderGeometry args={[0.62, 0.7, 0.26, 8, 1, false, Math.PI / 8]} />
        </mesh>
        <lineLoop geometry={rim} position={[0, 0.004, 0]}>
          <lineBasicMaterial color="#5ff7d0" toneMapped={false} />
        </lineLoop>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
          <planeGeometry args={[1.1, 1.1]} />
          <meshBasicMaterial map={pool} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 3]} intensity={2.2} />
      <pointLight position={[0, -0.7, 0.6]} intensity={3} color="#3ff0c4" distance={3} />
    </group>
  );
}

/** The live 3D Gema. `active` false stops rendering (off screen); `still` renders the rest pose only (poster capture). */
export default function GemCanvas({ active, still = false, onReady }: LiveCanvasProps) {
  const [dpr, setDpr] = useState(1.75);
  const [tilt, setTilt] = useState(!still);
  const frames = useRef(0);
  return (
    <Canvas
      frameloop={still ? "demand" : active ? "always" : "never"}
      dpr={[1, dpr]}
      camera={{ position: [0, -0.15, 5.6], fov: 30 }}
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: still }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      aria-hidden
    >
      <PerformanceMonitor onDecline={() => (dpr > 1 ? setDpr(1) : setTilt(false))} />
      <Showcase tilt={tilt} animate={!still} />
      <FirstFrame onFrame={() => frames.current++ === (still ? 0 : 1) && onReady?.()} />
    </Canvas>
  );
}

function FirstFrame({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}
