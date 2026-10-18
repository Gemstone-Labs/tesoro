"use client";

import { useSyncExternalStore } from "react";

/** Prototype: waitlist-first headline options, picked from the on-page switcher. */
export const HEADLINES: React.ReactNode[] = [
  <>
    Get <em className="lp-hl">real-money</em> access first.
  </>,
  <>
    Save your <em className="lp-hl">spot</em> for real-money play.
  </>,
  <>
    Real money is coming. <em className="lp-hl">Get in first.</em>
  </>,
  <>
    The waitlist plays for <em className="lp-hl">real</em> first.
  </>,
];

let current = 0;
const listeners = new Set<() => void>();
export const headlineStore = {
  get: () => current,
  set: (i: number) => {
    current = i;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const useHeadline = () => useSyncExternalStore(headlineStore.subscribe, headlineStore.get, () => 0);

export function WaitlistHeadline() {
  const i = useHeadline();
  return <h1 className="wl-h1">{HEADLINES[i]}</h1>;
}
