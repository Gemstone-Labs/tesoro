"use client";

import { useSyncExternalStore } from "react";

/** Prototype: waitlist-first headline options, picked from the on-page switcher. */
export const HEADLINES: React.ReactNode[] = [
  <>
    Save your <em className="lp-hl">spot</em> for launch day.
  </>,
  <>
    Launch day is <em className="lp-hl">waitlist only.</em>
  </>,
  <>
    Save your <em className="lp-hl">spot.</em> Play first when we launch.
  </>,
  <>
    Be <em className="lp-hl">first in</em> when Tesoro launches.
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
