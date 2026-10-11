"use client";

import { useSyncExternalStore } from "react";
import { DividerSvg } from "./DividerSvg";
import type { Frame, Kind } from "./dividers/geo";
import type { Spacing } from "./dividers/octa";

const subscribe = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
/** The frame's size and which line applies, as one string so the snapshot stays stable between renders. */
const frameKey = () => {
  const el = document.querySelector(".wl");
  return el ? `${el.clientWidth}x${el.clientHeight}x${matchMedia("(max-width: 640px)").matches ? "tall" : "wide"}` : "";
};

const subscribeSpacing = (notify: () => void) => {
  addEventListener("popstate", notify);
  return () => removeEventListener("popstate", notify);
};
/** `?s=1|2|3` picks a spacing while the founder compares them; empty otherwise. */
const spacingParam = () => new URLSearchParams(location.search).get("s") ?? "";

/** The divider laid out for the frame's real size. It fades in over the server's design-size layout. */
export function DividerLive() {
  const key = useSyncExternalStore(subscribe, frameKey, () => "");
  const sp = useSyncExternalStore(subscribeSpacing, spacingParam, () => "");
  if (!key) return null;
  const [w, h, kind] = key.split("x");
  const frame: Frame = { w: Number(w), h: Number(h), kind: kind as Kind };
  const spacing = (["1", "2", "3"].includes(sp) ? Number(sp) : 2) as Spacing;
  return (
    <>
      <DividerSvg key={spacing} frame={frame} spacing={spacing} id="dv-live" className="dv dv-live" />
      {sp && <Switcher spacing={spacing} />}
    </>
  );
}

const NAMES = { 1: "Tight", 2: "Graded", 3: "Open graded" } as const;

/** Temporary: only while `s` is in the URL. */
function Switcher({ spacing }: { spacing: Spacing }) {
  const pick = (k: Spacing) => {
    const url = new URL(location.href);
    url.searchParams.set("s", String(k));
    history.replaceState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <div className="dv-switch" role="group" aria-label="Gem spacing">
      {([1, 2, 3] as const).map((k) => (
        <button key={k} type="button" className="cut cut-chip" aria-pressed={spacing === k} title={NAMES[k]} onClick={() => pick(k)}>
          {k}
        </button>
      ))}
    </div>
  );
}
