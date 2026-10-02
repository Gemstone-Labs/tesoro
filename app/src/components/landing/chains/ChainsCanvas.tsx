"use client";

import { MeshRefractionMaterial, PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { studioEnvironment } from "../gem/envTexture";
import { GemMesh, glowTexture } from "../gem/GemMesh";
import { gemState } from "../gem/store";
import type { LiveCanvasProps } from "../Stage3D";
import { crystalCluster } from "./crystal";
import { CAMERA, CHAINS, LEDGER, type ChainsLayout } from "./layout";

const PARTICLES = 16;

/** A raw crystal cluster: refractive, flat-faceted prisms tinted per chain, with bright facet edges, a glowing core and a rock base. */
function Cluster({ color, seed, scale, animate }: { color: string; seed: number; scale: number; animate: boolean }) {
  const geometry = useMemo(() => crystalCluster(seed), [seed]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 20), [geometry]);
  const env = useMemo(() => studioEnvironment(), []);
  const core = useMemo(() => glowTexture("106,248,214", 0.55), []);
  const rock = useMemo(() => new THREE.MeshStandardMaterial({ color: "#2a353b", roughness: 0.8, metalness: 0.2, flatShading: true }), []);
  useEffect(() => () => (geometry.dispose(), edges.dispose(), env.dispose(), core.dispose(), rock.dispose()), [geometry, edges, env, core, rock]);
  const spin = useRef<THREE.Group>(null);
  const t = useRef(seed);
  useFrame((_, delta) => {
    if (!animate || !spin.current) return;
    t.current += delta;
    spin.current.rotation.y += delta * 0.22;
    spin.current.position.y = Math.sin(t.current * 0.9) * 0.04;
  });
  return (
    <group scale={scale}>
      <sprite scale={[1.6, 1.6, 1]} position={[0, 0.05, -0.2]}>
        <spriteMaterial map={core} color={color} transparent depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <group ref={spin} rotation={[0, seed, 0]}>
        <mesh geometry={geometry}>
          <MeshRefractionMaterial envMap={env} color={color} ior={1.75} bounces={2} fresnel={0.85} aberrationStrength={0} toneMapped={false} />
        </mesh>
        <lineSegments geometry={edges}>
          <lineBasicMaterial color="#effffa" transparent opacity={0.45} depthWrite={false} toneMapped={false} />
        </lineSegments>
      </group>
      <mesh material={rock} position={[0, -0.56, 0]} scale={[1, 0.38, 0.8]}>
        <dodecahedronGeometry args={[0.32, 0]} />
      </mesh>
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
            <Cluster color={c.color} seed={11 + i * 17} scale={i === 1 ? 0.95 : 1.02} animate={animate} />
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
