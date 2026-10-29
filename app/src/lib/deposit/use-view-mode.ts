"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { browserStore, type Store } from "@/lib/storage";
import { DEFAULT_VIEW_MODE, readViewMode, writeViewMode, type ViewMode } from "./view-mode";

/** Choices made during this visit, by Account key ("" before the key is known): they hold when storage can't. */
const chosen = new Map<string, ViewMode>();

/** The view a Player has: the one they chose (saved in this browser, or earlier this visit), else Simple. */
export function resolveViewMode(authority: string | null | undefined, store: Store | null = browserStore()): ViewMode {
  return (authority ? readViewMode(authority, store) : null) ?? chosen.get(authority ?? "") ?? DEFAULT_VIEW_MODE;
}

/** Remembers a choice for this visit and, once the Account key is known, in this browser. */
export function saveViewMode(authority: string | null | undefined, mode: ViewMode, store: Store | null = browserStore()): void {
  chosen.set(authority ?? "", mode);
  if (authority) writeViewMode(authority, mode, store);
}

const listeners = new Set<() => void>();

/**
 * Simple or Advanced for the signed-in Account, remembered per Account in this browser. Renders the default first and
 * reads the saved choice after mount (`resolved` turns true then), so server and browser markup match.
 */
export function useViewMode(): { mode: ViewMode; setMode: (mode: ViewMode) => void; resolved: boolean } {
  const auth = useAuth();
  // The Account's Solana address is known as soon as the Player is signed in; the signing wallet can load later.
  const authority = auth.addresses.solana ?? auth.signer?.publicKey.toBase58() ?? null;
  const [mode, setLocal] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    const read = () => {
      setLocal(resolveViewMode(authority));
      setResolved(true);
    };
    read();
    listeners.add(read);
    return () => void listeners.delete(read);
  }, [authority]);

  const setMode = useCallback(
    (next: ViewMode) => {
      saveViewMode(authority, next);
      setLocal(next);
      listeners.forEach((l) => l());
    },
    [authority],
  );
  return { mode, setMode, resolved };
}
