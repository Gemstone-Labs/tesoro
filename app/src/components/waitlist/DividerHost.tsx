"use client";

import { useSyncExternalStore } from "react";
import { DissolveEdge } from "./DissolveEdge";
import { VariantA } from "./dividers/VariantA";
import { VariantA1 } from "./dividers/VariantA1";
import { VariantA2 } from "./dividers/VariantA2";
import { VariantA3 } from "./dividers/VariantA3";
import { VariantA4 } from "./dividers/VariantA4";

const VARIANTS = { a: VariantA, a1: VariantA1, a2: VariantA2, a3: VariantA3, a4: VariantA4 } as const;
const NAMES = { a: "Stepped octagons", a1: "Halftone front", a2: "Octagon-square tiling", a3: "Size halftone", a4: "Consuming (animated)" } as const;
type Key = keyof typeof VARIANTS;

const subscribe = (notify: () => void) => {
  addEventListener("popstate", notify);
  return () => removeEventListener("popstate", notify);
};
const current = () => new URLSearchParams(location.search).get("d")?.toLowerCase() ?? "";

/**
 * The diagonal's edge. `/` keeps the dissolve until a variant is chosen; `?d=a`, `?d=a1`..`?d=a4` shows that variant and a small
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
