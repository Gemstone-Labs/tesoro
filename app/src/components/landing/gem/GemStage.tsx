"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { Stage3D } from "../Stage3D";
import { gemState } from "./store";

const GemCanvas = dynamic(() => import("./GemCanvas"), { ssr: false });

/** The Gemas section's gem: our own render as the poster (one per theme), with the live canvas fading in over it. */
export function GemStage() {
  useEffect(() => {
    const move = (e: PointerEvent) => {
      gemState.pointer.x = Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1));
      gemState.pointer.y = Math.max(-1, Math.min(1, (e.clientY / innerHeight) * 2 - 1));
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);
  return (
    <Stage3D
      Canvas={GemCanvas}
      className="lp-gem"
      poster={(["", "-light"] as const).map((t) => (
        <picture key={t} className={t ? "on-light" : "on-dark"}>
          <source type="image/avif" srcSet={`/art/landing/gem-poster${t}.avif`} />
          <img src={`/art/landing/gem-poster${t}.webp`} width={960} height={1200} alt="" loading="lazy" decoding="async" />
        </picture>
      ))}
    >
      <div className="lp-gem-glow" />
    </Stage3D>
  );
}
