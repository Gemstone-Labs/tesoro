"use client";

import { useSyncExternalStore } from "react";
import { DissolveEdge } from "./DissolveEdge";
import { VariantA } from "./dividers/VariantA";
import { VariantB } from "./dividers/VariantB";
import { VariantC } from "./dividers/VariantC";
import { VariantD } from "./dividers/VariantD";
import { VariantE } from "./dividers/VariantE";
import { VariantF } from "./dividers/VariantF";

const VARIANTS = { a: VariantA, b: VariantB, c: VariantC, d: VariantD, e: VariantE, f: VariantF } as const;
const NAMES = { a: "Stepped octagons", b: "Crystal cluster", c: "Faceted edge", d: "Texture filling in", e: "Gem hill", f: "Growing crystals" } as const;
type Key = keyof typeof VARIANTS;

const subscribe = (notify: () => void) => {
  addEventListener("popstate", notify);
  return () => removeEventListener("popstate", notify);
};
const current = () => new URLSearchParams(location.search).get("d")?.toLowerCase() ?? "";

/**
 * The diagonal's edge. `/` keeps the dissolve until a variant is chosen; `?d=a`..`?d=f` shows that variant and a small
 * switcher, so the founder can compare them on the real page.
 */
export function DividerHost() {
  const d = useSyncExternalStore(subscribe, current, () => "");
  const Variant = d in VARIANTS ? VARIANTS[d as Key] : null;
  const pick = (k: Key) => {
    const url = new URL(location.href);
    url.searchParams.set("d", k);
    history.replaceState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <>
      {Variant ? <Variant /> : <DissolveEdge />}
      {d && (
        <div className="dv-switch" role="group" aria-label="Divider variant">
          {(Object.keys(VARIANTS) as Key[]).map((k) => (
            <button key={k} type="button" className="cut cut-chip" aria-pressed={d === k} title={NAMES[k]} onClick={() => pick(k)}>
              {k.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
