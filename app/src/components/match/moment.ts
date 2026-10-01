/** Where "this Match's moment was shown" is remembered: sessionStorage (once per Match per tab). */
export type MomentStore = Pick<Storage, "getItem" | "setItem">;

export const momentStorageKey = (key: string) => `tesoro-moment:${key}`;

/**
 * Schedules the win overlay for the next tick, unless this Match's moment was already shown in this
 * tab. It is marked seen only when it actually shows, so a mount that is undone before then (React
 * StrictMode, leaving at once) does not use it up. Returns the cancel for the effect cleanup.
 */
export function scheduleMoment(key: string | undefined, store: MomentStore | null, show: () => void): () => void {
  const k = key ? momentStorageKey(key) : null;
  try {
    if (k && store?.getItem(k)) return () => {};
  } catch {
    // no storage: it shows once per page load
  }
  const timer = setTimeout(() => {
    try {
      if (k) store?.setItem(k, "1");
    } catch {
      // ignore
    }
    show();
  }, 0);
  return () => clearTimeout(timer);
}
