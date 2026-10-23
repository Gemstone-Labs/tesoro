type StorageLike = Pick<Storage, "getItem" | "setItem">;
type Vibrate = (pattern: number | number[]) => boolean;
const KEY = "tesoro.block-burst.vibration";

export function hapticPattern(lines: number, gems: number): number[] {
  return gems > 0 ? [12, 20, 22] : lines > 1 ? [18, 24, 12] : lines === 1 ? [14] : [6];
}

export function createHaptics(storage: () => StorageLike | null, device: () => Vibrate | undefined) {
  let preference: boolean | undefined;
  const listeners = new Set<() => void>();
  const enabled = () => {
    if (preference === undefined) {
      try { preference = storage()?.getItem(KEY) !== "off"; }
      catch { preference = true; }
    }
    return preference;
  };
  const invoke = (pattern: number | number[]) => {
    try { device()?.(pattern); } catch { /* Device policies may deny optional feedback. */ }
  };
  return {
    enabled,
    supported: () => typeof device() === "function",
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled: (next: boolean) => {
      preference = next;
      try { storage()?.setItem(KEY, next ? "on" : "off"); } catch { /* Keep the preference for this session if storage is unavailable. */ }
      if (!next) invoke(0);
      listeners.forEach((listener) => listener());
    },
    play: (lines: number, gems: number) => { if (enabled()) invoke(hapticPattern(lines, gems)); },
  };
}

export const blockHaptics = createHaptics(
  () => typeof window === "undefined" ? null : window.localStorage,
  () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? navigator.vibrate.bind(navigator) : undefined,
);
