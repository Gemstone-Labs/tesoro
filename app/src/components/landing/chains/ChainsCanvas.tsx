"use client";

import { MeshRefractionMaterial, PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { studioEnvironment } from "../gem/envTexture";
import { GemMesh, glowTexture } from "../gem/GemMesh";
import { gemState } from "../gem/store";
import type { LiveCanvasProps } from "../Stage3D";
import type { Theme } from "../theme";
import { useTheme } from "../useTheme";
import { CAMERA, CHAINS, LEDGER, type ChainLabel, type ChainsLayout } from "./layout";
import { chainLogo } from "./logos";
import { chainsProto } from "./proto";

const PARTICLES = 16;

/** Where a mark starts its spin: almost square to the camera, so it reads, with its depth just showing. The poster is rendered at this angle. */
const REST = 0.12;

/** A chain's mark cut as a stone: refractive and flat-faceted in the chain's own colours, with bright facet edges and its light behind. */
function Logo({ label, color, pace, animate }: { label: ChainLabel; color: string; pace: number; animate: boolean }) {
  const geometry = useMemo(() => chainLogo[label](), [label]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry, 20), [geometry]);
  const env = useMemo(() => studioEnvironment("neutral"), []);
  const light = useMemo(() => glowTexture("255,255,255", 0.5), []);
  useEffect(() => () => (geometry.dispose(), edges.dispose(), env.dispose(), light.dispose()), [geometry, edges, env, light]);
  const graded = geometry.hasAttribute("color");
  const spin = useRef<THREE.Group>(null);
  const t = useRef(0);
  useFrame((_, delta) => {
    if (!animate || !spin.current) return;
    t.current += delta;
    spin.current.rotation.y += delta * pace;
    spin.current.position.y = Math.sin(t.current * 0.9) * 0.04;
  });
  return (
    <group>
      <sprite scale={[1.9, 1.9, 1]} position={[0, 0, -0.3]}>
        <spriteMaterial map={light} color={color} transparent opacity={0.75} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <group ref={spin} rotation={[0, REST, 0]}>
        <mesh geometry={geometry}>
          <MeshRefractionMaterial
            envMap={env}
            color={graded ? "#ffffff" : color}
            vertexColors={graded}
            ior={1.75}
            bounces={2}
            fresnel={0.85}
            aberrationStrength={0}
            toneMapped={false}
          />
        </mesh>
        <lineSegments geometry={edges}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.45} depthWrite={false} toneMapped={false} />
        </lineSegments>
      </group>
    </group>
  );
}

/** Light travelling from one source to the ledger: a faint path and particles running along it. */
function Stream({ from, to, color, phase, animate, index = -1, count = PARTICLES }: { from: THREE.Vector3; to: THREE.Vector3; color: string; phase: number; animate: boolean; index?: number; count?: number }) {
  const path = useRef<THREE.MeshBasicMaterial>(null);
  const dot = useRef<THREE.MeshBasicMaterial>(null);
  const grow = useRef(1);
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
    const f = chainsProto.focus;
    const target = f < 0 || index < 0 ? 1 : f === index ? 1.6 : 0.25;
    grow.current += (target - grow.current) * Math.min(1, delta * 6);
    if (path.current) path.current.opacity = 0.32 * Math.min(1.4, grow.current);
    if (dot.current) dot.current.opacity = Math.min(1, grow.current);
    if (animate) time.current += delta * 0.16 * (f === index ? 2 : 1);
    for (let i = 0; i < count; i++) {
      const t = (time.current + i / count) % 1;
      tmp.position.copy(curve.getPointAt(t));
      tmp.scale.setScalar((0.35 + Math.sin(t * Math.PI) * 0.9) * Math.max(0.6, Math.min(1.3, grow.current)));
      tmp.rotation.set(t * 6, t * 4, 0);
      tmp.updateMatrix();
      dots.current.setMatrixAt(i, tmp.matrix);
    }
    dots.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <mesh geometry={tube}>
        <meshBasicMaterial ref={path} color={color} transparent opacity={0.32} toneMapped={false} />
      </mesh>
      <instancedMesh ref={dots} args={[undefined, undefined, count]}>
        <octahedronGeometry args={[0.05]} />
        <meshBasicMaterial ref={dot} color={color} transparent toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function Scene({ layout, animate, theme }: { layout: ChainsLayout; animate: boolean; theme: Theme }) {
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
  /** Where each stream leaves its mark: past its right edge (wide) or below it (tall). */
  const outlet = useMemo(() => (layout === "wide" ? new THREE.Vector3(0.58, 0, 0) : new THREE.Vector3(0, -0.72, 0)), [layout]);
  /** Where each stream enters the ledger: its near tip (wide) or its top face (tall). */
  const inlet = (s: THREE.Vector3) =>
    ledgerAt.clone().add(layout === "wide" ? new THREE.Vector3(-0.85, (s.y - ledgerAt.y) * 0.1, 0.1) : new THREE.Vector3(s.x * 0.22, 0.38, 0.1));
  return (
    <group ref={root}>
      {CHAINS.map((c, i) => {
        const color = (theme === "light" && c.onLight) || c.color;
        return (
          <group key={c.label}>
            <group position={sources[i]}>
              <Logo label={c.label} color={color} pace={0.22 + i * 0.03} animate={animate} />
            </group>
            <Stream from={sources[i].clone().add(outlet)} to={inlet(sources[i])} color={color} phase={i * 0.21} animate={animate} index={i} />
          </group>
        );
      })}
      <group position={ledgerAt}>
        <mesh position={[0, 0, -0.6]}>
          <planeGeometry args={[4, 4]} />
          <meshBasicMaterial map={halo} transparent opacity={0.75} depthWrite={false} toneMapped={false} />
        </mesh>
        <group ref={ledger} scale={1.45}>
          <group rotation={[0.35, 0, 0]}>
            <GemMesh />
          </group>
        </group>
      </group>
      {layout === "wide" && <OutStream ledgerAt={ledgerAt} animate={animate} color={theme === "light" ? "#0a9d74" : "#36f0be"} />}
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <pointLight position={[0, 0, 3]} intensity={2} color="#6af8d6" />
    </group>
  );
}

/** PROTOTYPE: Gemas leaving the ledger to the right, shown while `chainsProto.out` is on. */
function OutStream({ ledgerAt, animate, color }: { ledgerAt: THREE.Vector3; animate: boolean; color: string }) {
  const g = useRef<THREE.Group>(null);
  const from = useMemo(() => ledgerAt.clone().add(new THREE.Vector3(1.0, 0, 0.1)), [ledgerAt]);
  const to = useMemo(() => new THREE.Vector3(4.35, 0, 0), []);
  useFrame(() => g.current && (g.current.visible = chainsProto.out));
  return (
    <group ref={g} visible={false}>
      <Stream from={from} to={to} color={color} phase={0.1} animate={animate} count={4} />
    </group>
  );
}

export default function ChainsCanvas({ active, still = false, onReady, layout = "wide", theme }: LiveCanvasProps) {
  const page = useTheme();
  const [dpr, setDpr] = useState(() => (typeof window !== "undefined" && matchMedia("(max-width: 1023px)").matches ? 1.25 : 1.5));
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
      <Scene layout={layout} animate={!still} theme={theme ?? page} />
      <FirstFrame onFrame={() => frames.current++ === (still ? 0 : 1) && onReady?.()} />
    </Canvas>
  );
}

function FirstFrame({ onFrame }: { onFrame: () => void }) {
  useFrame(onFrame);
  return null;
}
