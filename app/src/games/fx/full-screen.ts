/**
 * Full screen for a game: the Arena covers the whole window (sidebar, top bar, footer and bottom
 * nav hidden under it) and, where the browser allows, the page goes into real full screen too.
 * Phones without the Fullscreen API (iPhone Safari) still get the covering Arena.
 * State lives here so every toggle on the page agrees.
 */

const CLASS = "game-full";
let on = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export const isFullScreen = () => on;

export function subscribeFullScreen(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function setFullScreen(next: boolean) {
  if (typeof document === "undefined" || next === on) return;
  on = next;
  document.documentElement.classList.toggle(CLASS, on);
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const native = doc.fullscreenElement ?? doc.webkitFullscreenElement;
  if (on && !native) {
    if (root.requestFullscreen) root.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    else root.webkitRequestFullscreen?.();
  } else if (!on && native) {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(() => undefined);
    else doc.webkitExitFullscreen?.();
  }
  emit();
}

/** Leaving the browser's full screen (Esc, a swipe) leaves the game's full screen too. */
export function watchNativeExit(): () => void {
  const onChange = () => {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    if (on && !(doc.fullscreenElement ?? doc.webkitFullscreenElement)) setFullScreen(false);
  };
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}
