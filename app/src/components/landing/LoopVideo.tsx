"use client";

import { useEffect, useRef } from "react";

/** A silent gameplay loop: the poster first; the video loads and plays only while in view, never under reduced motion. */
export function LoopVideo({ name, label, width, height }: { name: string; label: string; width: number; height: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return (
    <video
      ref={ref}
      className="lp-loop"
      muted
      loop
      playsInline
      preload="none"
      poster={`/art/landing/loop-${name}.webp`}
      width={width}
      height={height}
      data-tall={height > width || undefined}
      aria-label={label}
    >
      <source src={`/art/landing/loop-${name}.webm`} type="video/webm" />
      <source src={`/art/landing/loop-${name}.mp4`} type="video/mp4" />
    </video>
  );
}
