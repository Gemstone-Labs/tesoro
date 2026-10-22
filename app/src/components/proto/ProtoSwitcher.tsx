"use client";

// PROTOTYPE: floating variant switcher. Never ships: hidden in production builds.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function ProtoSwitcher({ param, variants, current }: { param: string; variants: { key: string; name: string }[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const i = Math.max(0, variants.findIndex((v) => v.key === current));

  const go = (step: number) => {
    const next = variants[(i + step + variants.length) % variants.length];
    const q = new URLSearchParams(params.toString());
    q.set(param, next.key);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]"))) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;
  const v = variants[i];
  return (
    <div
      className="proto-switcher"
      style={{
        position: "fixed", left: "50%", transform: "translateX(-50%)", zIndex: 9999,
        display: "flex", alignItems: "center", gap: 6, padding: 6, borderRadius: 999,
        background: "#fff", color: "#111", boxShadow: "0 8px 30px rgba(0,0,0,.5)", font: "600 14px system-ui, sans-serif",
      }}
    >
      <style>{".proto-switcher{bottom:20px}@media (max-width:767px){.proto-switcher{bottom:84px}}"}</style>
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant" style={btn}>←</button>
      <span style={{ padding: "0 10px", whiteSpace: "nowrap" }}>
        {v.key.toUpperCase()} · {v.name} <span style={{ opacity: 0.5 }}>({i + 1}/{variants.length})</span>
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant" style={btn}>→</button>
    </div>
  );
}

const btn = { width: 34, height: 34, borderRadius: 999, border: 0, background: "#111", color: "#fff", cursor: "pointer", fontSize: 16 } as const;
