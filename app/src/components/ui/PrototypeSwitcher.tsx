"use client";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "./primitives";

/** THROWAWAY review control, excluded in production. */
export function PrototypeSwitcher({ variants }: { variants: Record<string, string> }) {
  const params = useSearchParams();
  const keys = Object.keys(variants);
  const current = params.get("variant") ?? keys[0];
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable], [role="dialog"]') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const url = new URL(window.location.href);
      url.searchParams.set("variant", keys[(keys.indexOf(current) + (e.key === "ArrowLeft" ? -1 : 1) + keys.length) % keys.length]);
      window.history.replaceState(null, "", url);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [current, keys]);
  if (process.env.NODE_ENV === "production") return null;
  const move = (delta: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", keys[(keys.indexOf(current) + delta + keys.length) % keys.length]);
    window.history.replaceState(null, "", url);
  };
  return <nav className="wsp-switch cut cut-card" aria-label="Prototype variants"><Button aria-label="Previous variant" onClick={() => move(-1)}>←</Button><span>PROTOTYPE · {current}<b>{variants[current]}</b></span><Button aria-label="Next variant" onClick={() => move(1)}>→</Button></nav>;
}
