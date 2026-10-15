"use client";

import { useSyncExternalStore } from "react";

/** Whether the Limits sheet is open; opened from the Account menu. */
let open = false;
const listeners = new Set<() => void>();

export function setLimitsOpen(next: boolean) {
  open = next;
  listeners.forEach((l) => l());
}

export function useLimitsOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => open,
    () => false,
  );
}
