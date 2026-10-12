"use client";

import { Maximize2, Minimize2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { isFullScreen, setFullScreen, subscribeFullScreen } from "./full-screen";

/** Button for a game header: the game takes the whole screen, or goes back into the page. `<FullScreenToggle />`. */
export function FullScreenToggle({ className = "" }: { className?: string }) {
  const full = useSyncExternalStore(subscribeFullScreen, isFullScreen, () => false);
  const label = full ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      className={`cut cut-chip fx-mute fx-full ${className}`}
      aria-pressed={full}
      aria-label={label}
      title={`${label} (F)`}
      onClick={() => setFullScreen(!full)}
    >
      {full ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
    </button>
  );
}
