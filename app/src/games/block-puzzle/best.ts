const KEY = "tesoro.bp.best";

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Personal best of practice runs in this browser; 0 when none, or when storage is blocked. */
export function readBest(store: Store | null = browserStore()): number {
  try {
    const n = Number(store?.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function writeBest(score: number, store: Store | null = browserStore()): void {
  try {
    store?.setItem(KEY, String(Math.floor(score)));
  } catch {
    // storage blocked: the best lasts until reload
  }
}
