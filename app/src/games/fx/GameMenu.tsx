"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { LogOut, Maximize2, Minimize2, MoreHorizontal, Volume2, VolumeX } from "lucide-react";
import { armSound, isMuted, setMuted, sfx, subscribeMuted } from "./sfx";
import { isFullScreen, setFullScreen, subscribeFullScreen } from "./full-screen";
import "./game-menu.css";

export interface GameMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * The one control a game screen keeps besides its own: a ⋯ button whose menu holds sound, full screen, the game's own
 * items (How to play, Hand log) and Leave. Games never pause, so there is no pause here.
 */
export function GameMenu({ items = [], leaveHref, className = "" }: { items?: GameMenuItem[]; leaveHref?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  const full = useSyncExternalStore(subscribeFullScreen, isFullScreen, () => false);
  useEffect(() => armSound(), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className={`gmenu ${className}`} ref={root}>
      <button type="button" className="cut cut-chip gmenu-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label="Game menu" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div id={id} role="menu" className="cut cut-card gmenu-list">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={pick(it.onSelect)}>
              {it.icon} {it.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!muted}
            onClick={() => {
              setMuted(!muted);
              if (muted) queueMicrotask(() => sfx("tick"));
            }}
          >
            {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />} {muted ? "Sound off" : "Sound on"}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={full} onClick={pick(() => setFullScreen(!full))}>
            {full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />} {full ? "Exit full screen" : "Full screen"}
          </button>
          {leaveHref && (
            <Link href={leaveHref} role="menuitem" onClick={() => setOpen(false)}>
              <LogOut aria-hidden="true" /> Leave
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
