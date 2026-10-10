import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState } from "react";
import GemCanvas from "@/components/landing/gem/GemCanvas";
import ChainsCanvas from "@/components/landing/chains/ChainsCanvas";
import type { LiveCanvasProps } from "@/components/landing/Stage3D";
import "./motion.css";

type Live = (p: LiveCanvasProps) => React.ReactNode;

function Poster({ src, tall }: { src: string; tall?: boolean }) {
  return (
    <div className={`sbm-canvas${tall ? " tall" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ objectFit: "contain" }} />
    </div>
  );
}

function Live({ Canvas, layout, tall }: { Canvas: Live; layout?: "wide" | "tall"; tall?: boolean }) {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className={`sbm-canvas${tall ? " tall" : ""}`}>
      {on && <Canvas active layout={layout} onReady={() => setReady(true)} />}
      {!ready && <span className="sbm-note" style={{ position: "absolute" }}>Loading the live scene (needs WebGL)…</span>}
    </div>
  );
}

function Pair({ title, Canvas, poster, layout }: { title: string; Canvas: Live; poster: string; layout?: "wide" | "tall" }) {
  const tall = layout === "tall";
  return (
    <section className="sbm-panel">
      <h3>{title}</h3>
      <div className="sbm-compare">
        <div>
          <h4>Live 3D</h4>
          <Live Canvas={Canvas} layout={layout} tall={tall} />
        </div>
        <div>
          <h4>Poster (what phones, slow machines and Reduced motion see)</h4>
          <Poster src={poster} tall={tall} />
        </div>
      </div>
    </section>
  );
}

function Demo() {
  return (
    <div className="sbm">
      <Pair title="Gema showcase" Canvas={GemCanvas as Live} poster="/art/landing/gem-poster.webp" />
      <Pair title="Multichain, wide" Canvas={ChainsCanvas as Live} layout="wide" poster="/art/landing/chains-wide.webp" />
      <Pair title="Multichain, tall (phones)" Canvas={ChainsCanvas as Live} layout="tall" poster="/art/landing/chains-tall.webp" />
    </div>
  );
}

const meta = {
  title: "Motion/3D canvases",
  component: Demo,
  parameters: { layout: "padded", themed: true },
} satisfies Meta<typeof Demo>;
export default meta;

export const LiveAndPoster: StoryObj = {};
