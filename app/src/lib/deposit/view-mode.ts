import { browserStore, type Store } from "@/lib/storage";

/** Two bodies of the one Vault page. Simple: deposit packs. Advanced (the Player sees "Pro view"): chains, amounts and Lengths. */
export type ViewMode = "simple" | "advanced";

const key = (authority: string) => `tesoro:view:${authority}`;

/** Every Account starts in Simple (Pro view off), however the Player signed in; the Vault's gear turns Pro view on. */
export const DEFAULT_VIEW_MODE: ViewMode = "simple";

export function readViewMode(authority: string, store: Store | null = browserStore()): ViewMode | null {
  try {
    const v = store?.getItem(key(authority));
    return v === "simple" || v === "advanced" ? v : null;
  } catch {
    return null;
  }
}

export function writeViewMode(authority: string, mode: ViewMode, store: Store | null = browserStore()): void {
  try {
    store?.setItem(key(authority), mode);
  } catch {
    // Blocked storage: the default applies next time.
  }
}
