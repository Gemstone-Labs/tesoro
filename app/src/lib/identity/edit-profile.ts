"use client";

import { useSyncExternalStore } from "react";

/** Whether the Edit profile sheet is open; opened from the Account menu and from your own Account page. */
let open = false;
const listeners = new Set<() => void>();

export function setEditProfileOpen(next: boolean) {
  open = next;
  listeners.forEach((l) => l());
}

export function useEditProfileOpen(): boolean {
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
