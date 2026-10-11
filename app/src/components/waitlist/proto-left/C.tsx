"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { Stage3D, type LiveCanvasProps } from "@/components/landing/Stage3D";
import { gemState } from "@/components/landing/gem/store";

const GemCanvas = dynamic(() => import("@/components/landing/gem/GemCanvas"), { ssr: false });
/** The waitlist frame is dark in both themes: pin the scene's palette. */
const DarkGem = (p: LiveCanvasProps) => <GemCanvas {...p} theme="dark" />;

export function TheGema() {
  const lean = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = lean.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      const x = Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1));
      const y = Math.max(-1, Math.min(1, (e.clientY / innerHeight) * 2 - 1));
      gemState.pointer.x = x;
      gemState.pointer.y = y;
      el.style.setProperty("--lx", `${x * 7}deg`);
      el.style.setProperty("--ly", `${-y * 6}deg`);
      el.style.setProperty("--tx", `${x * 10}px`);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);

  return (
    <div className="pl-c-box">
      <span className="pl-c-glow" aria-hidden />
      <div className="pl-c-lean" ref={lean}>
        <Stage3D
          Canvas={DarkGem}
          className="pl-c-stage"
          poster={
            <picture>
              <source type="image/avif" srcSet="/art/landing/gem-poster.avif" />
              <img src="/art/landing/gem-poster.webp" width={960} height={1200} alt="" decoding="async" />
            </picture>
          }
        />
      </div>
      <p className="pl-c-cap">1 Gema = $0.01 when issued</p>
    </div>
  );
}
