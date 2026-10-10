"use client";

// PROTOTYPE: floating variant switcher. Throwaway, lives on proto/* branches only.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function PrototypeSwitcher({ variants, param = "variant" }: { variants: { key: string; name: string }[]; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get(param) ?? variants[0].key;
  const i = Math.max(0, variants.findIndex((v) => v.key === current));

  const go = (d: number) => {
    const next = variants[(i + d + variants.length) % variants.length];
    const q = new URLSearchParams(params.toString());
    q.set(param, next.key);
    router.replace(`${pathname}?${q}`, { scroll: false });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;
  const v = variants[i];
  return (
    <div style={{ position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 9999, display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 999, background: "#ff3df5", color: "#120012", font: "700 13px/1 system-ui, sans-serif", boxShadow: "0 8px 30px rgba(0,0,0,.5)" }}>
      <button type="button" onClick={() => go(-1)} style={btn} aria-label="Previous variant">←</button>
      <span style={{ padding: "0 8px", whiteSpace: "nowrap" }}>
        {v.key} ({v.name}) · {i + 1}/{variants.length}
      </span>
      <button type="button" onClick={() => go(1)} style={btn} aria-label="Next variant">→</button>
    </div>
  );
}

const btn: React.CSSProperties = { border: 0, borderRadius: 999, width: 30, height: 30, background: "#120012", color: "#ff3df5", font: "700 15px/1 system-ui", cursor: "pointer" };
