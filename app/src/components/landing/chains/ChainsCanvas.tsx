"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { studioEnvironment } from "../gem/envTexture";
import { GemMesh, glowTexture } from "../gem/GemMesh";
import { gemState } from "../gem/store";
import type { LiveCanvasProps } from "../Stage3D";
import { CAMERA, CHAINS, LEDGER, type ChainsLayout } from "./layout";

const PARTICLES = 16;

/** A raw crystal cluster: hexagonal prisms with pointed tips, glowing in the chain's tint. */
function Cluster({ color, scale, animate }: { color: string; scale: number; animate: boolean }) {
  const env = useMemo(() => studioEnvironment(), []);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, roughness: 0.06, metalness: 0.35, envMap: env, envMapIntensity: 1.3, flatShading: true }),
    [color, env],
  );
  useEffect(() => () => (material.dispose(), env.dispose()), [material, env]);
  const spin = useRef<THREE.Group>(null);
  useFrame((_, delta) => void (animate && spin.current && (spin.current.rotation.y += delta * 0.25)));
  const prisms: [number, number, number, number, number][] = [
    // h, r, x, z, lean
    [1.0, 0.13, 0, 0, 0],
    [0.72, 0.1, -0.2, 0.06, 0.38],
    [0.64, 0.095, 0.2, -0.05, -0.34],
    [0.46, 0.075, 0.09, 0.19, -0.16],
    [0.38, 0.07, -0.1, -0.18, 0.22],
  ];
  return (
    <group ref={spin} scale={scale} rotation={[0, 0.6, 0]}>
      {prisms.map(([h, r, x, z, lean], i) => (
        <group key={i} position={[x, -0.35, z]} rotation={[0, 0, lean]}>
          <mesh material={material} position={[0, h / 2, 0]}>
            <cylinderGeometry args={[r, r * 1.05, h, 6]} />
          </mesh>
          <mesh material={material} position={[0, h + r * 0.7, 0]}>
            <coneGeometry args={[r, r * 1.4, 6]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Light travelling from one source to the ledger: a faint path and particles running along it. */
function Stream({ from, to, color, phase, animate }: { from: THREE.Vector3; to: THREE.Vector3; color: string; phase: number; animate: boolean }) {
  const curve = useMemo(() => {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += (from.y - to.y) * 0.25;
    mid.z += 0.4;
    return new THREE.QuadraticBezierCurve3(from, mid, to);
  }, [from, to]);
  const tube = useMemo(() => new THREE.TubeGeometry(curve, 64, 0.012, 6), [curve]);
  const dots = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const time = useRef(phase);
  useEffect(() => () => tube.dispose(), [tube]);
  useFrame((_, delta) => {
    if (!dots.current) return;
    if (animate) time.current += delta * 0.16;
    for (let i = 0; i < PARTICLES; i++) {
      const t = (time.current + i / PARTICLES) % 1;
      tmp.position.copy(curve.getPointAt(t));
      tmp.scale.setScalar(0.35 + Math.sin(t * Math.PI) * 0.9);
      tmp.rotation.set(t * 6, t * 4, 0);
      tmp.updateMatrix();
      dots.current.setMatrixAt(i, tmp.matrix);
    }
    dots.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <mesh geometry={tube}>
        <meshBasicMaterial color={color} transparent opacity={0.32} toneMapped={false} />
      </mesh>
      <instancedMesh ref={dots} args={[undefined, undefined, PARTICLES]}>
        <octahedronGeometry args={[0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function Scene({ layout, animate }: { layout: ChainsLayout; animate: boolean }) {
  const root = useRef<THREE.Group>(null);
  const ledger = useRef<THREE.Group>(null);
  const halo = useMemo(() => glowTexture("54,240,190", 0.45), []);
  useEffect(() => () => halo.dispose(), [halo]);
  const ledgerAt = useMemo(() => new THREE.Vector3(...LEDGER[layout]), [layout]);
  const sources = useMemo(() => CHAINS.map((c) => new THREE.Vector3(...c.at[layout])), [layout]);
  const time = useRef(0);
  useFrame((_, delta) => {
    if (animate) time.current += delta;
    if (ledger.current) ledger.current.rotation.y = 0.5 + Math.sin(time.current * 0.4) * 0.6;
    if (root.current) {
      root.current.rotation.y += ((animate ? gemState.pointer.x * 0.08 : 0) - root.current.rotation.y) * 0.05;
      root.current.rotation.x += ((animate ? gemState.pointer.y * 0.05 : 0) - root.current.rotation.x) * 0.05;
    }
  });
  /** Where each stream enters the ledger: its near tip (wide) or its top face (tall). */
  const inlet = (s: THREE.Vector3) =>
    ledgerAt.clone().add(layout === "wide" ? new THREE.Vector3(-0.85, (s.y - ledgerAt.y) * 0.1, 0.1) : new THREE.Vector3(s.x * 0.22, 0.38, 0.1));
  return (
    <group ref={root}>
      {CHAINS.map((c, i) => (
        <group key={c.label}>
          <group position={sources[i]}>
            <Cluster color={c.color} scale={i === 1 ? 0.8 : 0.9} animate={animate} />
          </group>
          <Stream from={sources[i].clone().add(new THREE.Vector3(0.3, 0.1, 0))} to={inlet(sources[i])} color={c.color} phase={i * 0.21} animate={animate} />
        </group>
      ))}
      <group position={ledgerAt}>
        <mesh position={[0, 0, -0.6]}>
          <planeGeometry args={[4, 4]} />
          <meshBasicMaterial map={halo} transparent depthWrite={false} toneMapped={false} />
        </mesh>
        <group ref={ledger} scale={1.45}>
          <group rotation={[0.35, 0, 0]}>
            <GemMesh />
          </group>
        </group>
      </group>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <pointLight position={[0, 0, 3]} intensity={2} color="#6af8d6" />
    </group>
  );
}

export default function ChainsCanvas({ active, still = false, onReady, layout = "wide" }: LiveCanvasProps) {
  const [dpr, setDpr] = useState(1.5);
  const frames = useRef(0);
  return (
    <Canvas
      frameloop={still ? "demand" : active ? "always" : "never"}
      dpr={[1, dpr]}
      camera={{ position: [0, 0, CAMERA.z[layout]], fov: CAMERA.fov }}
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: still }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      aria-hidden
    >
      <PerformanceMonitor onDecline={() => setDpr(1)} />
      <Scene layout={layout} animate={!still} />
      <FirstFrame onFrame={() => frames.current++ === (still ? 0 : 1) && onReady?.()} />
    </Canvas>
  );
}

function FirstFrame({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}
