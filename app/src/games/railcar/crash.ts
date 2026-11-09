"use client";

/**
 * The crash moment: when a ride the Player is watching turns into its Result, the ride screen stays for a moment while the car
 * hits the wall (shake, flash, stop), then the Result shows. A page that opens on a Result goes straight to it.
 */
import { useEffect, useState } from "react";
import type { RailcarView } from "./view";

type RideView = Extract<RailcarView, { phase: "ride" }>;

/** How long the impact shows before the Result (about a second). Reduced motion gets a shorter fade. */
export const CRASH_MS = 1000;
export const CRASH_REDUCED_MS = 450;

/** The ride screen to keep showing while the Result waits: the ride just left, or the one already held; null when none. */
export function crashHold(prev: RailcarView, next: RailcarView, held: RideView | null): RideView | null {
  if (next.phase !== "result") return null;
  if (held) return held;
  return prev.phase === "ride" ? prev : null;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** The view to draw, and whether the crash is playing. */
export function useCrashMoment(view: RailcarView): { view: RailcarView; crash: boolean } {
  const [prev, setPrev] = useState(view);
  const [held, setHeld] = useState<RideView | null>(null);
  if (prev !== view) {
    setPrev(view);
    const h = crashHold(prev, view, held);
    if (h !== held) setHeld(h);
  }
  useEffect(() => {
    if (!held) return;
    const id = setTimeout(() => setHeld(null), reduced() ? CRASH_REDUCED_MS : CRASH_MS);
    return () => clearTimeout(id);
  }, [held]);
  return held ? { view: held, crash: true } : { view, crash: false };
}
