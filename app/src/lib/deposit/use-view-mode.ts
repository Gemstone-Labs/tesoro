"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { browserStore, type Store } from "@/lib/storage";
import { DEFAULT_VIEW_MODE, readViewMode, writeViewMode, type ViewMode } from "./view-mode";

/** The view a Player has: the one they chose, else Simple. */
export function resolveViewMode(authority: string | null | undefined, store: Store | null = browserStore()): ViewMode {
  return (authority ? readViewMode(authority, store) : null) ?? DEFAULT_VIEW_MODE;
}

const listeners = new Set<() => void>();

/**
 * Simple or Advanced for the signed-in Account, remembered per Account in this browser. Renders the default first and
 * reads the saved choice after mount (`resolved` turns true then), so server and browser markup match.
 */
export function useViewMode(): { mode: ViewMode; setMode: (mode: ViewMode) => void; resolved: boolean } {
  const auth = useAuth();
  const authority = auth.signer?.publicKey.toBase58() ?? null;
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
      if (authority) writeViewMode(authority, next);
      setLocal(next);
      listeners.forEach((l) => l());
    },
    [authority],
  );
  return { mode, setMode, resolved };
}
