"use client";

/**
 * PROTOTYPE ONLY. Floating bar that cycles `?variant=` on the current route. Never ships:
 * renders nothing in production builds.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

export function usePrototypeVariant<K extends string>(keys: readonly K[]): K {
  const v = useSearchParams().get("variant");
  return (keys as readonly string[]).includes(v ?? "") ? (v as K) : keys[0];
}

export function PrototypeSwitcher({ variants }: { variants: { key: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const current = Math.max(0, variants.findIndex((v) => v.key === params.get("variant")));

  const go = useCallback(
    (step: number) => {
      const next = variants[(current + step + variants.length) % variants.length];
      const q = new URLSearchParams(params.toString());
      q.set("variant", next.key);
      router.replace(`${path}?${q}`, { scroll: false });
    },
    [current, params, path, router, variants],
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

  if (process.env.NODE_ENV === "production") return null;
  const v = variants[current];
  const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "6px 12px", fontSize: 18, lineHeight: 1 };
  return (
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
    </div>
  );
}
