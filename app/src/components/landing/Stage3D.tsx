"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { Theme } from "./theme";

/** `theme` pins the scene's palette (poster capture); without it the canvas follows the page. */
export type LiveCanvasProps = { active: boolean; still?: boolean; onReady?: () => void; layout?: "wide" | "tall"; theme?: Theme };

/** Live 3D only where it can run well and motion is allowed; everyone else keeps the poster (a render of the same scene). */
export function canRunLive(minWidth = 1024) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (!matchMedia(`(min-width: ${minWidth}px)`).matches) return false;
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

/**
 * A lazily loaded 3D scene over its poster: the canvas chunk loads when the stage nears the viewport, renders only
 * while visible, and fades in over the poster once its first frame lands.
 */
export function Stage3D({
  Canvas,
  poster,
  className,
  minWidth,
  layout,
  children,
}: {
  Canvas: ComponentType<LiveCanvasProps>;
  poster: ReactNode;
  className: string;
  minWidth?: number;
  layout?: LiveCanvasProps["layout"];
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState(false);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canRunLive(minWidth)) return;
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
    return () => (near.disconnect(), seen.disconnect());
  }, [minWidth]);

  return (
    <div ref={ref} className={className} data-ready={ready} aria-hidden>
      {children}
      <div className="lp-stage-poster">{poster}</div>
      {load && (
        <div className="lp-stage-canvas">
          <Canvas active={visible} layout={layout} onReady={() => setReady(true)} />
        </div>
      )}
    </div>
  );
}
