"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { prefersReducedMotion } from "./reduced-motion";

export type BurstKind = "shards" | "sparks" | "confetti";

export interface BurstOptions {
  /** Viewport pixels (what `getBoundingClientRect` gives). Use `burstAt` for an element. */
  x: number;
  y: number;
  colors: string[];
  count?: number;
  kind?: BurstKind;
  /** Launch speed multiplier, 1 by default. */
  power?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  life: number;
  age: number;
  color: string;
  kind: BurstKind;
}

type Handle = (o: BurstOptions) => void;
let active: Handle | null = null;

/**
 * Throw particles from a point. No-op under reduced motion or when no `FxLayer` is mounted (an `Arena`
 * mounts one). `burst({ x, y, colors: ["#6ea8ff"], kind: "shards", count: 24 })`.
 */
export function burst(o: BurstOptions): void {
  if (!prefersReducedMotion()) active?.(o);
}

/** `burst` from the centre of an element: `burstAt(cellEl, { colors })`. */
export function burstAt(el: Element, o: Omit<BurstOptions, "x" | "y">): void {
  const r = el.getBoundingClientRect();
  burst({ ...o, x: r.left + r.width / 2, y: r.top + r.height / 2 });
}

const noSubscribe = () => () => {};

function octagon(c: CanvasRenderingContext2D, r: number) {
  const k = r * 0.4;
  c.beginPath();
  c.moveTo(-r + k, -r);
  c.lineTo(r - k, -r);
  c.lineTo(r, -r + k);
  c.lineTo(r, r - k);
  c.lineTo(r - k, r);
  c.lineTo(-r + k, r);
  c.lineTo(-r, r - k);
  c.lineTo(-r, -r + k);
  c.closePath();
}

/**
 * The canvas the bursts draw on: fixed over the page, ignores the pointer, and only runs animation
 * frames while particles are alive. Mount once per game screen (`Arena` does).
 */
export function FxLayer() {
  const host = useSyncExternalStore(noSubscribe, () => document.body, () => null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    const c = cv?.getContext("2d");
    if (!host || !cv || !c) return;
    let parts: Particle[] = [];
    let raf = 0;
    let last = 0;
    let dpr = 1;

    const size = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
    };
    size();
    window.addEventListener("resize", size);

    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
      last = t;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.scale(dpr, dpr);
      parts = parts.filter((p) => p.age < p.life);
      for (const p of parts) {
        p.age += dt;
        p.vy += (p.kind === "sparks" ? 260 : 900) * dt;
        p.vx *= 1 - 0.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        const k = 1 - p.age / p.life;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.globalAlpha = Math.min(1, k * 1.6);
        c.fillStyle = p.color;
        if (p.kind === "sparks") {
          c.shadowColor = p.color;
          c.shadowBlur = 8;
          c.beginPath();
          c.arc(0, 0, p.size * 0.5 * (0.4 + k), 0, Math.PI * 2);
          c.fill();
        } else if (p.kind === "confetti") {
          c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          octagon(c, p.size * (0.5 + k * 0.5));
          c.fill();
        }
        c.restore();
      }
      raf = parts.length ? requestAnimationFrame(frame) : 0;
    };

    active = ({ x, y, colors, count = 18, kind = "shards", power = 1 }) => {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = (80 + Math.random() * 360) * power;
        parts.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 140 * power,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 14,
          size: kind === "sparks" ? 3 + Math.random() * 4 : 5 + Math.random() * 8,
          life: 0.55 + Math.random() * 0.6,
          age: 0,
          color: colors[i % colors.length],
          kind,
        });
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    const mine = active;

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      if (active === mine) active = null;
    };
  }, [host]);

  if (!host) return null;
  return createPortal(<canvas ref={canvas} className="fx-layer" aria-hidden="true" />, host);
}
