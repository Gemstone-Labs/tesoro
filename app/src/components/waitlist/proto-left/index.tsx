"use client";

/* THROWAWAY prototype: ways to make the waitlist's left half more exciting. ?v=A..E (and ?proto=1 on a production
   build). Delete this folder and its one line in (marketing)/page.tsx when a variant is picked. */
import { Suspense, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import "./proto.css";
import { LiveWins } from "./A";
import { TheLine } from "./B";
import { TheGema } from "./C";
import { LivingTexture } from "./D";
import { KineticType } from "./E";

const ORDER = ["", "A", "B", "C", "D", "E"] as const;
const LABEL: Record<string, string> = { "": "Current", A: "Live wins", B: "The line", C: "The Gema", D: "Living texture", E: "Kinetic type" };

function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const enabled = process.env.NODE_ENV !== "production" || params.get("proto") === "1";
  const raw = (params.get("v") ?? "").toUpperCase();
  const v = (ORDER as readonly string[]).includes(raw) ? raw : "";
  const zone = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (to: string) => {
      const next = new URLSearchParams(params.toString());
      if (to) next.set("v", to);
      else next.delete("v");
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = ORDER.indexOf(v as (typeof ORDER)[number]);
      go(ORDER[(i + (e.key === "ArrowRight" ? 1 : -1) + ORDER.length) % ORDER.length]);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [enabled, v, go]);

  // The zone ends above the form block, wherever that block starts.
  useEffect(() => {
    const main = document.querySelector<HTMLElement>(".wl-main");
    if (!enabled || !main) return;
    const set = () => zone.current?.style.setProperty("--main-top", `${main.offsetTop}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(main);
    return () => ro.disconnect();
  }, [enabled, v]);

  if (!enabled) return null;
  const i = ORDER.indexOf(v as (typeof ORDER)[number]);
  return (
    <>
      {v === "D" && <LivingTexture />}
      {v && v !== "D" && (
        <div className={`pl-zone pl-${v.toLowerCase()}`} ref={zone}>
          {v === "A" && <LiveWins />}
          {v === "B" && <TheLine />}
          {v === "C" && <TheGema />}
          {v === "E" && <KineticType />}
        </div>
      )}
      <div className="pl-switch" role="group" aria-label="Prototype variant">
        <button type="button" onClick={() => go(ORDER[(i + ORDER.length - 1) % ORDER.length])} aria-label="Previous variant">
          ←
        </button>
        <span>{v ? `${v} · ${LABEL[v]}` : "Current page"}</span>
        <button type="button" onClick={() => go(ORDER[(i + 1) % ORDER.length])} aria-label="Next variant">
          →
        </button>
      </div>
    </>
  );
}

export function ProtoLeft() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
