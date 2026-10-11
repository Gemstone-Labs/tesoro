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
import { TEXTURES, TEXTURE_KEYS } from "./textures";

const ORDER = ["", "A", "B", "C", "D", "E"] as const;
const LABEL: Record<string, string> = { "": "Current", A: "Live wins", B: "The line", C: "The Gema", D: "Living texture", E: "Kinetic type" };

function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const enabled = process.env.NODE_ENV !== "production" || params.get("proto") === "1";
  const raw = (params.get("v") ?? "").toUpperCase();
  const v = (ORDER as readonly string[]).includes(raw) ? raw : "";
  const t = TEXTURE_KEYS.includes(params.get("t") ?? "") ? params.get("t")! : "0";
  const zone = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (to: string, name = "v") => {
      const next = new URLSearchParams(params.toString());
      if (to) next.set(name, to);
      else next.delete(name);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (v === "D" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const k = TEXTURE_KEYS.indexOf(t);
        go(TEXTURE_KEYS[(k + (e.key === "ArrowDown" ? 1 : -1) + TEXTURE_KEYS.length) % TEXTURE_KEYS.length], "t");
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = ORDER.indexOf(v as (typeof ORDER)[number]);
      go(ORDER[(i + (e.key === "ArrowRight" ? 1 : -1) + ORDER.length) % ORDER.length]);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [enabled, v, t, go]);

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
      {v === "D" && <LivingTexture tex={t} />}
      {v && v !== "D" && (
        <div className={`pl-zone pl-${v.toLowerCase()}`} ref={zone}>
          {v === "A" && <LiveWins />}
          {v === "B" && <TheLine />}
          {v === "C" && <TheGema />}
          {v === "E" && <KineticType />}
        </div>
      )}
      {v === "D" && (
        <div className="pl-switch pl-switch-t" role="group" aria-label="Background pattern">
          <button type="button" onClick={() => go(TEXTURE_KEYS[(TEXTURE_KEYS.indexOf(t) + TEXTURE_KEYS.length - 1) % TEXTURE_KEYS.length], "t")} aria-label="Previous pattern">
            ↑
          </button>
          <span>Pattern {t} · {TEXTURES[t].name}</span>
          <button type="button" onClick={() => go(TEXTURE_KEYS[(TEXTURE_KEYS.indexOf(t) + 1) % TEXTURE_KEYS.length], "t")} aria-label="Next pattern">
            ↓
          </button>
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
