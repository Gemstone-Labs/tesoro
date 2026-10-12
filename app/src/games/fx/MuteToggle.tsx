"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { armSound, isMuted, setMuted, sfx, subscribeMuted } from "./sfx";

/** Speaker button for a game header: turns sound off or on and remembers it. `<MuteToggle />`. */
export function MuteToggle({ className = "" }: { className?: string }) {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  useEffect(() => armSound(), []);
  return (
    <button
      type="button"
      className={`cut cut-chip fx-mute ${className}`}
      aria-pressed={muted}
      aria-label={muted ? "Sound off. Turn sound on" : "Sound on. Turn sound off"}
      title={muted ? "Sound off" : "Sound on"}
      onClick={() => {
        setMuted(!muted);
        if (muted) queueMicrotask(() => sfx("tick"));
      }}
    >
      {muted ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
    </button>
  );
}
