import type { GameId } from "@/lib/mock/types";
import { browserStore, type Store } from "@/lib/storage";

/** Two bodies of the one Vault page. Simple: deposit packs. Advanced: chains, amounts and Lengths. */
export type ViewMode = "simple" | "advanced";

const key = (authority: string) => `tesoro:view:${authority}`;

/** New Accounts start in Simple; a Player who signed in with their own wallet starts in Advanced. */
export const defaultViewMode = (linkedWallets: number): ViewMode => (linkedWallets > 0 ? "advanced" : "simple");

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

/** Where "Get Gemas" goes. A game passes what it needs so the right pack (or amount) is preset. */
export function getGemasHref(mode: ViewMode, intent?: { game: GameId; need?: number | null }): string {
  const q = new URLSearchParams();
  q.set(mode === "simple" ? "deposit" : "open", "1");
  if (intent?.need) q.set("need", String(intent.need));
  if (intent) q.set("game", intent.game);
  return `/vault?${q.toString()}`;
}
