"use client";

/** PROTOTYPE ONLY: the floating variant bar. Never on main. */
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const SHOW = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_VERCEL_ENV === "preview";

export function PrototypeSwitcher({
  variants,
  current,
  extra,
}: {
  variants: { key: string; name: string }[];
  current: string;
  /** A second param to flip, e.g. the fake Account's size. */
  extra?: { param: string; values: string[]; current: string };
}) {
  const router = useRouter();
  const path = usePathname();
  const i = Math.max(0, variants.findIndex((v) => v.key === current));

  const go = (patch: Record<string, string>) => {
    const q = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) q.set(k, v);
    router.replace(`${path}?${q}`, { scroll: false });
  };
  const step = (d: number) => go({ variant: variants[(i + d + variants.length) % variants.length].key });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!SHOW) return null;
  return (
    <div className="proto-bar" role="toolbar" aria-label="Prototype variants">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">←</button>
      <span>
        <b>{variants[i].key}</b> {variants[i].name}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">→</button>
      {extra && (
        <select aria-label={extra.param} value={extra.current} onChange={(e) => go({ [extra.param]: e.target.value })}>
          {extra.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      )}
      <style>{`
        .proto-bar { position: fixed; z-index: 9999; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; padding: 6px; border-radius: 999px; background: #fff; color: #111; font: 600 13px/1 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45); white-space: nowrap; max-width: calc(100vw - 16px); }
        .proto-bar button { all: unset; cursor: pointer; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 999px; background: #111; color: #fff; font-size: 16px; }
        .proto-bar span { padding: 0 8px; overflow: hidden; text-overflow: ellipsis; }
        .proto-bar b { background: #ff3d7f; color: #fff; border-radius: 4px; padding: 2px 6px; margin-right: 4px; }
        .proto-bar select { font: inherit; border: 1px solid #ccc; border-radius: 999px; padding: 6px 8px; background: #f3f3f3; color: #111; }
      `}</style>
    </div>
  );
}
