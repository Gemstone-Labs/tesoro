"use client";

/**
 * PROTOTYPE ONLY. Floating bar that cycles `?variant=` on the current page. Never ships: renders
 * nothing in production builds. Reads and writes the address bar itself (not the Next router), so
 * it works the same in the app and in Storybook.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const EVENT = "prototype-variant";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("popstate", cb);
  };
}
const read = () => new URLSearchParams(window.location.search).get("variant");

export function usePrototypeVariant<K extends string>(keys: readonly K[]): K {
  const v = useSyncExternalStore(subscribe, read, () => null);
  return (keys as readonly string[]).includes(v ?? "") ? (v as K) : keys[0];
}

export function PrototypeSwitcher({ variants }: { variants: readonly { key: string; name: string }[] }) {
  const key = usePrototypeVariant(variants.map((v) => v.key));
  const current = Math.max(0, variants.findIndex((v) => v.key === key));
  // Portalled to <body>: a clip-path or transform on any ancestor (every .cut shape) would clip or trap a fixed bar.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- prototype: mount once, then portal
  useEffect(() => setMounted(true), []);

  const go = useCallback(
    (step: number) => {
      const next = variants[(current + step + variants.length) % variants.length];
      const url = new URL(window.location.href);
      url.searchParams.set("variant", next.key);
      window.history.replaceState(window.history.state, "", url);
      window.dispatchEvent(new Event(EVENT));
    },
    [current, variants],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (process.env.NODE_ENV === "production" || !mounted) return null;
  const v = variants[current];
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "6px 12px", fontSize: 18, lineHeight: 1 };
  return createPortal(
    <div
      style={{
        position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 9999,
        display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderRadius: 999,
        background: "#ff3df0", color: "#14001a", font: "700 14px/1 system-ui, sans-serif",
        boxShadow: "0 8px 30px rgba(0,0,0,.5)",
      }}
    >
      <button type="button" style={btn} onClick={() => go(-1)} aria-label="Previous variant">←</button>
      <span style={{ padding: "0 6px", whiteSpace: "nowrap" }}>
        PROTOTYPE · {v.key} ({v.name}) · {current + 1}/{variants.length}
      </span>
      <button type="button" style={btn} onClick={() => go(1)} aria-label="Next variant">→</button>
    </div>,
    document.body,
  );
}
