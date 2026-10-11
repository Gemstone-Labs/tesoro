"use client";

import { useSyncExternalStore } from "react";
import { DividerSvg } from "./DividerSvg";
import type { Frame, Kind } from "./dividers/geo";

const subscribe = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
/** The frame's size and which line applies, as one string so the snapshot stays stable between renders. */
const frameKey = () => {
  const el = document.querySelector(".wl");
  return el ? `${el.clientWidth}x${el.clientHeight}x${matchMedia("(max-width: 640px)").matches ? "tall" : "wide"}` : "";
};

/** The divider laid out for the frame's real size. It fades in over the server's design-size layout. */
export function DividerLive() {
  const key = useSyncExternalStore(subscribe, frameKey, () => "");
  if (!key) return null;
  const [w, h, kind] = key.split("x");
  const frame: Frame = { w: Number(w), h: Number(h), kind: kind as Kind };
  return <DividerSvg frame={frame} id="dv-live" className="dv dv-live" />;
}
