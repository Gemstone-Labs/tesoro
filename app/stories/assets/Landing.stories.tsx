import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LANDING_ART } from "@/lib/landing/art.generated";
import { Kit, Quote, Section, Tile, CopyPath } from "../kit/Kit";

const meta = { title: "Assets/Landing", parameters: { layout: "padded", shell: "marketing" } } satisfies Meta;
export default meta;
type Story = StoryObj;

const dir = Object.keys(import.meta.glob("/public/art/landing/*")).map((p) => p.replace("/public", ""));
const WIDTHED = /-\d+\.(avif|webp)$/;
const isLight = (k: string) => /Light/.test(k);

/** Every image `landingArt` knows, at every width and format. Read from `art.generated.ts`, which the import script writes. */
export const Manifest: Story = {
  render: () => {
    const keys = Object.keys(LANDING_ART).sort();
    return (
      <Kit>
        <Quote>Astra&apos;s art for the landing page, imported by scripts/import-landing-art.mjs. Each key has one or more widths in avif and webp; the page picks by screen size.</Quote>
        {keys.map((k) => {
          const a = LANDING_ART[k]!;
          return (
            <Section key={k} title={`${k}${isLight(k) ? "  (light theme)" : ""}`} note={`Source ${a.w} × ${a.h}. Widths: ${a.widths.join(", ")}.`}>
              <div className="kit-grid" style={{ ["--min" as string]: "220px" }}>
                {a.widths.flatMap((w) => (["avif", "webp"] as const).map((f) => <Tile key={`${w}${f}`} path={`/art/landing/${k}-${w}.${f}`} ground="checker" maxH={150} />))}
              </div>
            </Section>
          );
        })}
      </Kit>
    );
  },
};

/** The other files in the folder: posters for the 3D scenes (one per theme), the octagon frames and the Backing figure. */
export const Posters: Story = {
  render: () => {
    const rest = dir.filter((p) => !WIDTHED.test(p) && !/loop-|\.glb$/.test(p));
    const pairs = rest.filter((p) => !/-light\./.test(p));
    return (
      <Kit>
        <Section title="Dark and light variants" note="Files named -light are for the light theme; the page swaps them with .on-dark and .on-light.">
          <div className="kit-grid" style={{ ["--min" as string]: "240px" }}>
            {pairs.map((p) => {
              const light = p.replace(/(\.\w+)$/, "-light$1");
              return (
                <div key={p} className="stack">
                  <Tile path={p} ground="dark" maxH={200} />
                  {rest.includes(light) && <Tile path={light} ground="light" maxH={200} />}
                </div>
              );
            })}
          </div>
        </Section>
      </Kit>
    );
  },
};

const loops = [...new Set(dir.filter((p) => /loop-.*\.(webm|mp4|webp)$/.test(p)).map((p) => p.replace(/\.\w+$/, "")))].sort();

function Loop({ base }: { base: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  return (
    <div className="stack">
      <video ref={ref} muted loop playsInline preload="metadata" poster={`${base}.webp`} style={{ maxWidth: "100%", maxHeight: 420, background: "#090d0f" }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}>
        <source src={`${base}.webm`} type="video/webm" />
        <source src={`${base}.mp4`} type="video/mp4" />
      </video>
      <div className="kit-row">
        <button type="button" className="btn neutral cut cut-btn sm" onClick={toggle}>{playing ? "Pause" : "Play"}</button>
        {["webm", "mp4", "webp"].map((e) => <CopyPath key={e} path={`${base}.${e}`} />)}
      </div>
      <span className="kit-tile-meta">{base}.(webm | mp4 | webp poster)</span>
    </div>
  );
}

/** The game recordings on the landing page. webm and mp4 are the same loop; the webp is its poster. */
export const Loops: Story = {
  render: () => (
    <Kit>
      <div className="kit-grid" style={{ ["--min" as string]: "340px" }}>
        {loops.map((b) => <Loop key={b} base={b} />)}
      </div>
    </Kit>
  ),
};

const GemCanvas = lazy(() => import("@/components/landing/gem/GemCanvas"));
const ChainsCanvas = lazy(() => import("@/components/landing/chains/ChainsCanvas"));

function Bytes({ path }: { path: string }) {
  const [text, setText] = useState("…");
  useEffect(() => {
    fetch(path, { method: "HEAD" }).then((r) => setText(`${(Number(r.headers.get("content-length")) / 1024).toFixed(0)} KB`)).catch(() => setText("unknown size"));
  }, [path]);
  return <>{text}</>;
}

function Live({ children, height }: { children: React.ReactNode; height: number }) {
  return (
    <div style={{ position: "relative", height, background: "var(--surface-art)", border: "1px solid var(--line)" }}>
      <Suspense fallback={<span className="meta" style={{ padding: 12, display: "block" }}>Loading the scene…</span>}>{children}</Suspense>
    </div>
  );
}

/** The Gema stone live in 3D, next to the posters that stand in for it where WebGL is off. Change the toolbar Theme to see both looks. */
export const GemaModel: Story = {
  render: () => (
    <Kit>
      <Quote>The glb is an export of the same stone (scripts/export-gem-glb.mjs, 14.5 × 10 mm, flat-faceted). The page builds the live scene from code (GemCanvas); the glb is for outside tools.</Quote>
      <div className="kit-row">
        <CopyPath path="/art/landing/gema.glb" />
        <span className="kit-tile-meta">/art/landing/gema.glb · <Bytes path="/art/landing/gema.glb" /></span>
      </div>
      <Section title="Live (GemCanvas)">
        <Live height={480}><GemCanvas active /></Live>
      </Section>
      <Section title="Posters">
        <div className="kit-grid" style={{ ["--min" as string]: "240px" }}>
          <Tile path="/art/landing/gem-poster.webp" ground="dark" maxH={260} />
          <Tile path="/art/landing/gem-poster-light.webp" ground="light" maxH={260} />
        </div>
      </Section>
      <Section title="Multichain scene (ChainsCanvas)">
        <Live height={360}><ChainsCanvas active layout="wide" /></Live>
      </Section>
    </Kit>
  ),
};
