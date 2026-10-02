"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { LiveCanvasProps } from "../Stage3D";
import type { Theme } from "../theme";
import { useTheme } from "../useTheme";
import { GemMesh, glowTexture } from "./GemMesh";
import { gemState } from "./store";

/** Tilt per Gemas beat while the gem spins: table on, crown steps, pavilion. */
const BEAT_TILT = [0, 0.22, -0.38];
const SPIN = 0.55;
const TILT = 0.12;
/** The rest pose for the poster: table almost facing the viewer. */
const REST_YAW = -0.45;

/** The stage around the stone. Dark: steel plinth, light drawn in emerald. Light: pale stone plinth, the lines and pools in deep emerald ink. */
const LOOK = {
  dark: { plinth: { color: "#1b252b", metalness: 0.8, roughness: 0.42 }, line: "#5ff7d0", ring: "#6af8d6", ringOpacity: 0.28, pool: "54,240,190", blending: THREE.AdditiveBlending },
  light: { plinth: { color: "#e9ebe6", metalness: 0.2, roughness: 0.6 }, line: "#0a7d5c", ring: "#0a7d5c", ringOpacity: 0.45, pool: "10,125,92", blending: THREE.NormalBlending },
} as const;

/** Three small Gemas circling the stone on a tilted ring of light: one play unit, on every chain. */
function Orbit({ animate, theme }: { animate: boolean; theme: Theme }) {
  const ring = useRef<THREE.Group>(null);
  const ringGeo = useMemo(() => {
    const pts = Array.from({ length: 129 }, (_, i) => {
      const a = (i / 128) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 1.12, 0, Math.sin(a) * 1.12);
    });
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);
  useEffect(() => () => ringGeo.dispose(), [ringGeo]);
  useFrame((_, delta) => void (animate && ring.current && (ring.current.rotation.y -= delta * 0.35)));
  return (
    <group rotation={[0.42, 0, -0.18]}>
      <line>
        <primitive object={ringGeo} attach="geometry" />
        <lineBasicMaterial color={LOOK[theme].ring} transparent opacity={LOOK[theme].ringOpacity} toneMapped={false} />
      </line>
      <group ref={ring}>
        {[0, 1, 2].map((i) => {
          const a = (i / 3) * Math.PI * 2;
          return (
            <group key={i} position={[Math.cos(a) * 1.12, 0, Math.sin(a) * 1.12]} rotation={[0.5, a, 0.3]} scale={0.16}>
              <GemMesh />
            </group>
          );
        })}
      </group>
    </group>
  );
}

/** The Gema standing on its end on an octagonal plinth, spinning. */
function Showcase({ tilt, animate, theme }: { tilt: boolean; animate: boolean; theme: Theme }) {
  const look = LOOK[theme];
  const spin = useRef<THREE.Group>(null);
  const lean = useRef<THREE.Group>(null);
  const yaw = useRef(REST_YAW);
  const time = useRef(0);
  const pool = useMemo(() => glowTexture(look.pool, 0.42), [look]);
  const plinth = useMemo(() => new THREE.MeshStandardMaterial(look.plinth), [look]);
  /** The plinth's top edge, an emerald octagon line. */
  const rim = useMemo(() => {
    const pts = Array.from({ length: 8 }, (_, i) => {
      const a = (Math.PI / 4) * i;
      return new THREE.Vector3(Math.sin(a) * 0.62, 0, Math.cos(a) * 0.62);
    });
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);
  useEffect(() => () => (pool.dispose(), plinth.dispose()), [pool, plinth]);
  useEffect(() => () => rim.dispose(), [rim]);

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
      <Orbit animate={animate} theme={theme} />
      <group position={[0, -1.02, 0]}>
        <mesh material={plinth} position={[0, -0.13, 0]}>
          <cylinderGeometry args={[0.62, 0.7, 0.26, 8, 1, false, Math.PI / 8]} />
        </mesh>
        <lineLoop geometry={rim} position={[0, 0.004, 0]}>
          <lineBasicMaterial color={look.line} toneMapped={false} />
        </lineLoop>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.26, 0]}>
          <planeGeometry args={[3.2, 3.2]} />
          <meshBasicMaterial map={pool} transparent opacity={0.55} blending={look.blending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
          <planeGeometry args={[1.1, 1.1]} />
          <meshBasicMaterial map={pool} transparent blending={look.blending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 3]} intensity={2.2} />
      <pointLight position={[0, -0.7, 0.6]} intensity={3} color="#3ff0c4" distance={3} />
    </group>
  );
}

/** The live 3D Gema. `active` false stops rendering (off screen); `still` renders the rest pose only (poster capture). */
export default function GemCanvas({ active, still = false, onReady, theme }: LiveCanvasProps) {
  const page = useTheme();
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
      <Showcase tilt={tilt} animate={!still} theme={theme ?? page} />
      <FirstFrame onFrame={() => frames.current++ === (still ? 0 : 1) && onReady?.()} />
    </Canvas>
  );
}

function FirstFrame({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}
