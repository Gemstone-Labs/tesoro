"use client";

/**
 * PROTOTYPE ONLY (proto/facet-crown-11-10-2026). Five takes on the Wallet balance panel's facet crown,
 * switched with `?variant=` on /wallet. Question: the crown reads as a faint wireframe trapezoid peeking
 * from the panel's bottom edge; what should money decoration look like here?
 *   now = today's /brand/facet-crown.svg background
 *   A Jewel      solid lit step cut in the corner, a glint sweeps across it
 *   B Panel cut  the panel itself is the stone: step bevels follow its chamfers, content sits on the table
 *   C Refraction no stone: the crown's light thrown across the panel as slow hard-edged shards
 *   D Tilt       a stone lying at an angle, tilts and glints with the pointer
 *   E Filling    the crown fills with emerald as yield accrues (Pending → Redeemable); `&fill=0..1` overrides
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import "./facet-crown-proto.css";

export const CROWN_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Jewel" },
  { key: "B", name: "Panel cut" },
  { key: "C", name: "Refraction" },
  { key: "D", name: "Tilt" },
  { key: "E", name: "Filling" },
] as const;
export type CrownKey = (typeof CROWN_VARIANTS)[number]["key"];

type Pt = [number, number];
const K = Math.SQRT2 - 1;
const pts = (p: Pt[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** Emerald-cut octagon of width w, height h, corner c, inset d (outline points clockwise from top-left). */
function oct(w: number, h: number, c: number, d: number): Pt[] {
  const e = c + d * K;
  return [[e, d], [w - e, d], [w - d, e], [w - d, h - e], [w - e, h - d], [e, h - d], [d, h - e], [d, e]];
}

/** Facet quads between consecutive rings: [ring][side] → points. Side 0 = top, clockwise. */
function facets(rings: Pt[][]) {
  const out: { r: number; i: number; p: Pt[] }[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r], b = rings[r + 1];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      out.push({ r, i, p: [a[i], a[j], b[j], b[i]] });
    }
  }
  return out;
}

// Light from above: top facets brightest, bottom darkest (0..1).
const LIGHT = [1, 0.72, 0.5, 0.3, 0.12, 0.26, 0.46, 0.68];
const mix = (a: number[], b: number[], t: number) => a.map((v, k) => Math.round(v + (b[k] - v) * t));
const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const DEEP = [4, 46, 36], MID = [18, 150, 114], HI = [120, 240, 206];
const stone = (l: number) => (l < 0.5 ? rgb(mix(DEEP, MID, l * 2)) : rgb(mix(MID, HI, (l - 0.5) * 2)));

/** A solid step cut, lit from above. */
function SolidStone({ w, h, c, insets, id, className }: { w: number; h: number; c: number; insets: number[]; id: string; className?: string }) {
  const rings = insets.map((d) => oct(w, h, c, d));
  const table = rings[rings.length - 1];
  return (
    <svg className={className} viewBox={`-2 -2 ${w + 4} ${h + 4}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7ef7d6" />
          <stop offset=".47" stopColor="#3fe0b4" />
          <stop offset=".47" stopColor="#16b88a" />
          <stop offset="1" stopColor="#0c8a67" />
        </linearGradient>
        <clipPath id={`${id}-clip`}><polygon points={pts(rings[0])} /></clipPath>
      </defs>
      {facets(rings).map(({ r, i, p }) => (
        <polygon key={`${r}-${i}`} points={pts(p)} fill={stone(LIGHT[i] * (1 - r * 0.12) + r * 0.04)} />
      ))}
      <polygon points={pts(table)} fill={`url(#${id}-t)`} />
      <g fill="none" stroke="#d6fff2" strokeOpacity=".35" strokeWidth="1" strokeLinejoin="round">
        {rings.map((r, k) => <polygon key={k} points={pts(r)} />)}
        {rings[0].map((p, k) => <line key={k} x1={p[0]} y1={p[1]} x2={table[k][0]} y2={table[k][1]} />)}
      </g>
      <g clipPath={`url(#${id}-clip)`}>
        <g transform={`rotate(24 ${w / 2} ${h / 2})`}>
          <rect className="fcp-glint" x={-w * 0.6} y={-h} width={w * 0.16} height={h * 3} fill="#fff" opacity=".5" />
        </g>
      </g>
    </svg>
  );
}

/* ——— A: Jewel ——— */
function Jewel() {
  return (
    <div className="fcp fcp-a" aria-hidden="true">
      <div className="fcp-a-glow" />
      <SolidStone className="fcp-a-stone" id="fcpa" w={560} h={420} c={120} insets={[0, 40, 80, 122]} />
    </div>
  );
}

/* ——— B: Panel cut ——— */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function PanelCut() {
  const [ref, size] = useSize<HTMLDivElement>();
  const narrow = (size?.w ?? 1000) < 600;
  const insets = narrow ? [0, 4, 8, 13] : [0, 9, 18, 30];
  return (
    <div className="fcp fcp-b" ref={ref} aria-hidden="true">
      {size && (() => {
        const { w, h } = size;
        const rings = insets.map((d) => oct(w, h, 22, d));
        const table = rings[rings.length - 1];
        return (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <defs>
              <radialGradient id="fcpb-t" cx=".3" cy="0" r="1.1">
                <stop offset="0" stopColor="#7efada" stopOpacity=".14" />
                <stop offset=".6" stopColor="#7efada" stopOpacity=".03" />
                <stop offset="1" stopColor="#7efada" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="fcpb-l" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#c6fff0" stopOpacity=".55" />
                <stop offset="1" stopColor="#7efada" stopOpacity=".12" />
              </linearGradient>
            </defs>
            {facets(rings).map(({ r, i, p }) => (
              <polygon key={`${r}-${i}`} points={pts(p)} fill="#8dfbe0" fillOpacity={(0.03 + LIGHT[i] * 0.22) * (1 - r * 0.28)} />
            ))}
            <polygon points={pts(table)} fill="url(#fcpb-t)" />
            {/* hard-stop light across the table, like a facet catching the light */}
            <polygon points={`${w * 0.52},${insets[3]} ${w * 0.7},${insets[3]} ${w * 0.38},${h - insets[3]} ${w * 0.2},${h - insets[3]}`} fill="#7efada" fillOpacity=".035" />
            <polygon points={`${w * 0.74},${insets[3]} ${w * 0.78},${insets[3]} ${w * 0.46},${h - insets[3]} ${w * 0.42},${h - insets[3]}`} fill="#7efada" fillOpacity=".05" />
            <g fill="none" stroke="url(#fcpb-l)" strokeWidth="1" strokeLinejoin="round">
              {rings.slice(1).map((r, k) => <polygon key={k} points={pts(r)} />)}
              {rings[0].map((p, k) => <line key={k} x1={p[0]} y1={p[1]} x2={table[k][0]} y2={table[k][1]} />)}
            </g>
          </svg>
        );
      })()}
    </div>
  );
}

/* ——— C: Refraction ——— */
function Refraction() {
  // shards fan out from a point above the panel's top right, each a hard-edged slice of light
  const shards: { a: number; s: number; o: number; len: number }[] = [
    { a: 104, s: 7, o: 0.09, len: 1400 }, { a: 118, s: 3, o: 0.14, len: 1300 }, { a: 128, s: 10, o: 0.05, len: 1500 },
    { a: 143, s: 4, o: 0.11, len: 1200 }, { a: 152, s: 2, o: 0.18, len: 1100 }, { a: 163, s: 8, o: 0.05, len: 1300 },
    { a: 176, s: 3, o: 0.1, len: 1000 },
  ];
  const ox = 0, oy = 0;
  const ray = (a: number, s: number, len: number) => {
    const r = (d: number) => (d * Math.PI) / 180;
    const p1: Pt = [ox + Math.cos(r(a - s / 2)) * len, oy + Math.sin(r(a - s / 2)) * len];
    const p2: Pt = [ox + Math.cos(r(a + s / 2)) * len, oy + Math.sin(r(a + s / 2)) * len];
    return pts([[ox, oy], p1, p2]);
  };
  return (
    <div className="fcp fcp-c" aria-hidden="true">
      <svg className="fcp-c-rays" viewBox="-1500 -100 1600 1600">
        <defs>
          <linearGradient id="fcpc-f" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b8ffec" />
            <stop offset="1" stopColor="#24d8a8" stopOpacity="0" />
          </linearGradient>
        </defs>
        {shards.map((s, k) => (
          <polygon key={k} className={`fcp-c-ray r${k % 3}`} points={ray(s.a, s.s, s.len)} fill="url(#fcpc-f)" opacity={s.o} />
        ))}
      </svg>
      {/* the source: a small lit stone at the panel's top right, the only solid thing */}
      <SolidStone className="fcp-c-src" id="fcpc" w={140} h={105} c={30} insets={[0, 10, 20, 31]} />
      {/* scattered facet-shaped light patches where the shards land */}
      <svg className="fcp-c-patches" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon points="58,62 66,58 70,66 62,72" fill="#7efada" opacity=".06" />
        <polygon points="40,78 45,74 48,80 43,84" fill="#7efada" opacity=".08" />
        <polygon points="74,80 82,76 85,86 77,90" fill="#7efada" opacity=".05" />
      </svg>
    </div>
  );
}

/* ——— D: Tilt ——— */
function Tilt() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    const el = ref.current;
    if (!host || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--rx", `${52 - y * 14}deg`);
      el.style.setProperty("--rz", `${-24 + x * 18}deg`);
      el.style.setProperty("--gx", `${(x + 0.5) * 100}%`);
    };
    const leave = () => { el.style.removeProperty("--rx"); el.style.removeProperty("--rz"); el.style.removeProperty("--gx"); };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => { host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", leave); };
  }, []);
  return (
    <div className="fcp fcp-d" ref={ref} aria-hidden="true">
      <div className="fcp-d-shadow" />
      <div className="fcp-d-stone">
        <SolidStone id="fcpd" w={560} h={420} c={120} insets={[0, 40, 80, 122]} />
        <div className="fcp-d-glint" />
      </div>
    </div>
  );
}

/* ——— E: Filling ——— */
function Filling({ share }: { share: number }) {
  const q = useSearchParams().get("fill");
  const target = q !== null && !Number.isNaN(+q) ? Math.min(1, Math.max(0, +q)) : share;
  const [fill, setFill] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setFill(target), 300);
    return () => clearTimeout(t);
  }, [target]);
  const w = 300, h = 420, c = 70;
  const insets = [0, 24, 48, 74];
  const rings = insets.map((d) => oct(w, h, c, d));
  const table = rings[rings.length - 1];
  const level = h - h * fill;
  return (
    <div className="fcp fcp-e" aria-hidden="true">
      <svg viewBox={`-2 -2 ${w + 4} ${h + 4}`}>
        <defs>
          <clipPath id="fcpe-c"><polygon points={pts(rings[0])} /></clipPath>
          <linearGradient id="fcpe-t" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7ef7d6" /><stop offset=".47" stopColor="#3fe0b4" />
            <stop offset=".47" stopColor="#16b88a" /><stop offset="1" stopColor="#0c8a67" />
          </linearGradient>
        </defs>
        {/* empty stone: facet outlines on dark glass */}
        {facets(rings).map(({ r, i, p }) => (
          <polygon key={`e${r}-${i}`} points={pts(p)} fill="#7efada" fillOpacity={0.02 + LIGHT[i] * 0.05} />
        ))}
        {/* lit part, clipped to the fill level: the same stone, solid */}
        <g clipPath="url(#fcpe-c)">
          <g className="fcp-e-lit" style={{ clipPath: `inset(${(level / h) * 100}% 0 0 0)` }}>
            {facets(rings).map(({ r, i, p }) => (
              <polygon key={`f${r}-${i}`} points={pts(p)} fill={stone(LIGHT[i] * (1 - r * 0.12) + r * 0.04)} />
            ))}
            <polygon points={pts(table)} fill="url(#fcpe-t)" />
          </g>
          <line className="fcp-e-level" x1="0" x2={w} y1="0" y2="0" stroke="#d6fff2" strokeWidth="2" style={{ transform: `translateY(${level}px)` }} />
        </g>
        <g fill="none" stroke="#c6fff0" strokeOpacity=".4" strokeWidth="1.2" strokeLinejoin="round">
          {rings.map((r, k) => <polygon key={k} points={pts(r)} />)}
          {rings[0].map((p, k) => <line key={k} x1={p[0]} y1={p[1]} x2={table[k][0]} y2={table[k][1]} />)}
        </g>
      </svg>
    </div>
  );
}

export function FacetCrownVariant({ variant, share }: { variant: CrownKey; share: number }) {
  if (variant === "A") return <Jewel />;
  if (variant === "B") return <PanelCut />;
  if (variant === "C") return <Refraction />;
  if (variant === "D") return <Tilt />;
  if (variant === "E") return <Filling share={share} />;
  return null;
}
