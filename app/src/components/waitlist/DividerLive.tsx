"use client";

import { useSyncExternalStore } from "react";
import { DividerSvg } from "./DividerSvg";
import type { Frame, Kind } from "./dividers/geo";
import type { Tuning } from "./dividers/octa";

const subscribe = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
/** The frame's size and which line applies, as one string so the snapshot stays stable between renders. */
const frameKey = () => {
  const el = document.querySelector(".wl");
  return el ? `${el.clientWidth}x${el.clientHeight}x${matchMedia("(max-width: 640px)").matches ? "tall" : "wide"}` : "";
};

const subscribeTuning = (notify: () => void) => {
  addEventListener("popstate", notify);
  return () => removeEventListener("popstate", notify);
};
/** `?g=1|2|3` picks a growth tuning while the founder compares them; empty otherwise. */
const tuningParam = () => new URLSearchParams(location.search).get("g") ?? "";

/** The divider laid out for the frame's real size. It fades in over the server's design-size layout. */
export function DividerLive() {
  const key = useSyncExternalStore(subscribe, frameKey, () => "");
  const g = useSyncExternalStore(subscribeTuning, tuningParam, () => "");
  if (!key) return null;
  const [w, h, kind] = key.split("x");
  const frame: Frame = { w: Number(w), h: Number(h), kind: kind as Kind };
  const tuning = (["1", "2", "3"].includes(g) ? Number(g) : 1) as Tuning;
  return (
    <>
      <DividerSvg key={tuning} frame={frame} tuning={tuning} id="dv-live" className="dv dv-live" />
      {g && <Switcher tuning={tuning} />}
    </>
  );
}

const NAMES = { 1: "Fingers", 2: "Clumps", 3: "Mixed" } as const;

/** Temporary: only while `g` is in the URL. */
function Switcher({ tuning }: { tuning: Tuning }) {
  const pick = (k: Tuning) => {
    const url = new URL(location.href);
    url.searchParams.set("g", String(k));
    history.replaceState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <div className="dv-switch" role="group" aria-label="Growth tuning">
      {([1, 2, 3] as const).map((k) => (
        <button key={k} type="button" className="cut cut-chip" aria-pressed={tuning === k} title={NAMES[k]} onClick={() => pick(k)}>
          {k}
        </button>
      ))}
    </div>
  );
}
