"use client";

import { useEffect, useSyncExternalStore } from "react";
import { OUTBOUND } from "@/lib/landing/config";
import "./x-follow.css";

export const X_HANDLE = "@PlayTesoro";
export type XVariant = "a" | "b" | "c" | "d";
const VARIANTS: readonly XVariant[] = ["a", "b", "c", "d"];
const DEFAULT_VARIANT: XVariant = "c";
const KEY = "tesoro-xv";

const isVariant = (v: string | null): v is XVariant => !!v && (VARIANTS as readonly string[]).includes(v);

function read(): XVariant {
  try {
    const q = new URLSearchParams(location.search).get("xv");
    if (isVariant(q)) return q;
  } catch {}
  try {
    const s = localStorage.getItem(KEY);
    if (isVariant(s)) return s;
  } catch {}
  return DEFAULT_VARIANT;
}

const subscribe = (cb: () => void) => {
  addEventListener("popstate", cb);
  addEventListener("storage", cb);
  return () => {
    removeEventListener("popstate", cb);
    removeEventListener("storage", cb);
  };
};

/** The X style being compared: `?xv=a|b|c|d`, remembered in localStorage. */
export function useXVariant(): XVariant {
  const v = useSyncExternalStore(subscribe, read, () => DEFAULT_VARIANT);
  useEffect(() => {
    try {
      if (isVariant(new URLSearchParams(location.search).get("xv"))) localStorage.setItem(KEY, v);
    } catch {}
  }, [v]);
  return v;
}

/** The X mark, monochrome. */
export function XMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="xf-mark" viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

/** head = in a header (compact, always visible), cta = beside a call to action, foot = in a footer. */
export type XPlace = "head" | "cta" | "foot";

export function XFollow({ place, className = "" }: { place: XPlace; className?: string }) {
  const v = useXVariant();
  if (!OUTBOUND.x) return null;
  const link = { href: OUTBOUND.x, target: "_blank", rel: "noopener" } as const;
  const base = `xf xf-${v} xf-${place} ${className}`;

  if (place === "foot") {
    return (
      <a {...link} className={`${base} xf-link`}>
        <XMark size={14} />
        <span>Follow {X_HANDLE}</span>
      </a>
    );
  }
  // d keeps the buttons quiet: an icon in headers, a plain link beside calls to action. Its strip carries the message.
  if (v === "d") {
    return place === "head" ? (
      <a {...link} className={`${base} cut icon-btn`} aria-label={`Follow ${X_HANDLE} on X`}>
        <XMark />
      </a>
    ) : (
      <a {...link} className={`${base} xf-link`}>
        <XMark size={15} />
        <span>Follow {X_HANDLE}</span>
      </a>
    );
  }
  if (v === "a" && place === "head") {
    return (
      <a {...link} className={`${base} cut icon-btn`} aria-label={`Follow ${X_HANDLE} on X`}>
        <XMark />
      </a>
    );
  }
  const label = place === "head" ? "Follow" : v === "c" ? "Follow on X" : `Follow ${X_HANDLE}`;
  return (
    <a {...link} className={`${base} btn cut cut-btn ${v === "c" ? "" : "neutral"}`} aria-label={`Follow ${X_HANDLE} on X`}>
      <XMark size={place === "head" ? 16 : 18} />
      <span className="xf-label">{label}</span>
    </a>
  );
}

/** Variant d: a slim strip under the header on the waitlist and the landing page. Other variants render nothing. */
export function XStrip() {
  const v = useXVariant();
  if (v !== "d" || !OUTBOUND.x) return null;
  return (
    <div className="xf-strip">
      <a href={OUTBOUND.x} target="_blank" rel="noopener" className="cut cut-chip">
        <XMark size={15} />
        <span>
          Follow <b>{X_HANDLE}</b> on X for launch news
        </span>
        <i aria-hidden>Follow</i>
      </a>
    </div>
  );
}
