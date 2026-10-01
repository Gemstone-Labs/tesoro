"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

const GemCanvas = dynamic(() => import("./GemCanvas"), { ssr: false });

export function PosterGem() {
  const [ready, setReady] = useState(false);
  return (
    <div id="gem-poster" data-ready={ready} style={{ width: 1200, height: 1200, background: "transparent" }}>
      <GemCanvas active still onReady={() => setReady(true)} />
    </div>
  );
}
