"use client";

import { useEffect, useRef, useState } from "react";

const K = Math.SQRT2 - 1;
/** Light from above, per side clockwise from the top: top facets brightest, the bottom darkest. */
const LIGHT = [1, 0.72, 0.5, 0.3, 0.12, 0.26, 0.46, 0.68];

type Pt = [number, number];
const pts = (p: Pt[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** The panel's octagon (corner `c`, the frame's cut) inset by `d`, clockwise from the top left. */
function ring(w: number, h: number, c: number, d: number): Pt[] {
  const e = c + d * K;
  return [[e, d], [w - e, d], [w - d, e], [w - d, h - e], [w - e, h - d], [e, h - d], [d, h - e], [d, e]];
}

/**
 * The facet crown: the panel itself cut as an emerald step cut. Three thin bevels follow the frame's
 * chamfers, lit from above, and the content sits on the table, crossed by two hard-stop light bands.
 * Drop it as the first child of a `.facet-panel` (money surfaces only).
 */
export function FacetCrown() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="facet-crown" ref={ref} aria-hidden="true">
      {size && <Cut w={size.w} h={size.h} />}
    </div>
  );
}

function Cut({ w, h }: { w: number; h: number }) {
  // phone-width panels have 18px of padding: keep the bevels inside it
  const insets = w < 600 ? [0, 4, 8, 13] : [0, 9, 18, 30];
  const rings = insets.map((d) => ring(w, h, 22, d));
  const table = rings[rings.length - 1];
  const t = insets[insets.length - 1];
  const band = (top: number, topEnd: number, bottom: number, bottomEnd: number) =>
    `${w * top},${t} ${w * topEnd},${t} ${w * bottomEnd},${h - t} ${w * bottom},${h - t}`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <radialGradient id="facet-crown-table" cx=".3" cy="0" r="1.1">
          <stop offset="0" stopColor="#7efada" stopOpacity=".14" />
          <stop offset=".6" stopColor="#7efada" stopOpacity=".03" />
          <stop offset="1" stopColor="#7efada" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="facet-crown-line" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c6fff0" stopOpacity=".55" />
          <stop offset="1" stopColor="#7efada" stopOpacity=".12" />
        </linearGradient>
      </defs>
      {rings.slice(0, -1).map((a, r) =>
        a.map((_, i) => {
          const b = rings[r + 1], j = (i + 1) % 8;
          const alpha = (0.03 + LIGHT[i] * 0.22) * (1 - r * 0.28);
          return <polygon key={`${r}-${i}`} points={pts([a[i], a[j], b[j], b[i]])} fill="#8dfbe0" fillOpacity={alpha.toFixed(3)} />;
        }),
      )}
      <polygon points={pts(table)} fill="url(#facet-crown-table)" />
      <polygon points={band(0.52, 0.7, 0.2, 0.38)} fill="#7efada" fillOpacity=".035" />
      <polygon points={band(0.74, 0.78, 0.42, 0.46)} fill="#7efada" fillOpacity=".05" />
      <g fill="none" stroke="url(#facet-crown-line)" strokeWidth="1" strokeLinejoin="round">
        {rings.slice(1).map((r, k) => <polygon key={k} points={pts(r)} />)}
        {rings[0].map((p, k) => <line key={k} x1={p[0]} y1={p[1]} x2={table[k][0]} y2={table[k][1]} />)}
      </g>
    </svg>
  );
}
