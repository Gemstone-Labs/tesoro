"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui";

/**
 * Day the devnet test balances were reset for the new yield model (ADR 0010). Ticket 07 sets it at deploy;
 * a new date shows the note again to everyone who dismissed an older one.
 */
export const RESET_DATE = "2026-10-19";

const storageKey = `tesoro-reset-note:${RESET_DATE}`;

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

const listeners = new Set<() => void>();
let dismissedHere = false;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const unseen = () => {
  if (dismissedHere) return false;
  try {
    return localStorage.getItem(storageKey) === null;
  } catch {
    return true;
  }
};

/** One-time Wallet note: test balances were reset. Dismissal is kept per viewer in this browser only. */
export function ResetNote({ date = RESET_DATE }: { date?: string }) {
  const shown = useSyncExternalStore(subscribe, unseen, () => false);
  if (!shown) return null;
  const dismiss = () => {
    dismissedHere = true;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
    listeners.forEach((fn) => fn());
  };
  return (
    <div className="status wl-reset" role="status">
      <span>Test balances were reset on {longDate(date)} for a new yield model. Get Gemas to start again.</span>
      <Button size="sm" onClick={dismiss}>Got it</Button>
    </div>
  );
}
