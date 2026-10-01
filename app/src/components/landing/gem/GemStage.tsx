"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { gemState } from "./store";

const GemCanvas = dynamic(() => import("./GemCanvas"), { ssr: false });

/** Live 3D only on desktop-class devices that allow motion and have WebGL; everyone else keeps the poster. */
function canRunLive() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (!matchMedia("(min-width: 1024px)").matches) return false;
  if ((navigator.hardwareConcurrency ?? 8) < 4) return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

const idle = (fn: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200);

/** The Gemas section's gem: our own render as the poster, with the live canvas fading in over it once its first frame lands. */
export function GemStage() {
  const ref = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState(false);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canRunLive()) return;
    const near = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        near.disconnect();
        idle(() => setLoad(true));
      },
      { rootMargin: "150% 0px" },
    );
    const seen = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    near.observe(el);
    seen.observe(el);
    const move = (e: PointerEvent) => {
      gemState.pointer.x = Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1));
      gemState.pointer.y = Math.max(-1, Math.min(1, (e.clientY / innerHeight) * 2 - 1));
    };
    addEventListener("pointermove", move, { passive: true });
    return () => {
      near.disconnect();
      seen.disconnect();
      removeEventListener("pointermove", move);
    };
  }, []);

  return (
    <div ref={ref} className="lp-gem" data-ready={ready} aria-hidden>
      <div className="lp-gem-glow" />
      <picture className="lp-gem-poster">
        <source type="image/avif" srcSet="/art/landing/gem-poster.avif" />
        <img src="/art/landing/gem-poster.webp" width={1200} height={1200} alt="" loading="lazy" decoding="async" />
      </picture>
      {load && (
        <div className="lp-gem-canvas">
          <GemCanvas active={visible} onReady={() => setReady(true)} />
        </div>
      )}
    </div>
  );
}
