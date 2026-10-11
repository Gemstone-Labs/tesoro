"use client";

import { useSyncExternalStore } from "react";
import { INNER, OUTER, dissolveCells, type Variant } from "./dissolve";

const path = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${x} ${y}`).join("L")}Z`;

const subscribe = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
/** The frame's size, as one string so the snapshot stays stable between renders. */
const frame = () => {
  const el = document.querySelector(".wl");
  return el ? `${el.clientWidth}x${el.clientHeight}x${matchMedia("(max-width: 640px)").matches ? "tall" : "wide"}` : "";
};

/**
 * The dark side breaking into the footage: octagon cells in the page's own colour on the landing texture's grid, so the
 * texture seems to step out over the videos. Laid out for the frame's real size, so it is drawn after hydration.
 */
export function DissolveEdge() {
  const snap = useSyncExternalStore(subscribe, frame, () => "");
  if (!snap) return <svg className="de" aria-hidden />;
  const [w, h, variant] = snap.split("x");
  const cells = dissolveCells(Number(w), Number(h), variant as Variant);
  return (
    <svg className="de" aria-hidden focusable="false">
      <defs>
        <g id="de-cell">
          <path className="de-body" d={path(OUTER)} vectorEffect="non-scaling-stroke" />
          <path className="de-line" d={path(INNER)} vectorEffect="non-scaling-stroke" />
        </g>
      </defs>
      {cells.map((c) => (
        <use
          key={c.key}
          href="#de-cell"
          className={c.fade ? "de-fade" : undefined}
          style={c.fade ? ({ "--k": c.k } as React.CSSProperties) : undefined}
          transform={`translate(${c.x} ${c.y}) scale(${c.scale.toFixed(3)})`}
        />
      ))}
    </svg>
  );
}
