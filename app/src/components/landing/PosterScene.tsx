"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { ASPECT } from "./chains/layout";

const GemCanvas = dynamic(() => import("./gem/GemCanvas"), { ssr: false });
const ChainsCanvas = dynamic(() => import("./chains/ChainsCanvas"), { ssr: false });

export type PosterKind = "gem" | "chains-wide" | "chains-tall";

/** Sizes of each poster in CSS px (the capture is at device scale 1). */
export const POSTER_SIZE: Record<PosterKind, [number, number]> = {
  gem: [960, 1200],
  "chains-wide": [1920, Math.round(1920 / ASPECT.wide)],
  "chains-tall": [900, Math.round(900 / ASPECT.tall)],
};

export function PosterScene({ kind }: { kind: PosterKind }) {
  const [ready, setReady] = useState(false);
  const [w, h] = POSTER_SIZE[kind];
  return (
    <div id="poster" data-ready={ready} style={{ width: w, height: h, background: "transparent" }}>
      {kind === "gem" ? (
        <GemCanvas active still onReady={() => setReady(true)} />
      ) : (
        <ChainsCanvas active still layout={kind === "chains-wide" ? "wide" : "tall"} onReady={() => setReady(true)} />
      )}
    </div>
  );
}
