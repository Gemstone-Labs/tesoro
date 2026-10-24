/**
 * Full screen for a game: the Arena covers the whole browser window, with the sidebar, top bar,
 * footer and bottom nav hidden under it. It never asks for the browser's own full screen (iPhone
 * Safari has none, and elsewhere it needs a tap at the moment it turns on), so it works the same on
 * every device. State lives here so every toggle on the page agrees.
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
  emit();
}

/** A route's first game enters automatically; board/result replacements respect the Player's toggle. */
export function createCoverSession() {
  let entered = false;
  return {
    enter() {
      if (entered) return;
      entered = true;
      setFullScreen(true);
    },
    leave() {
      entered = false;
      setFullScreen(false);
    },
  };
}
