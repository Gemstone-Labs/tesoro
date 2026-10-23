"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
 * items (How to play, Hand log) and Leave. The list is portalled out of cut cards so their clip-path cannot clip it.
 */
export function GameMenu({ items = [], leaveHref, className = "" }: { items?: GameMenuItem[]; leaveHref?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const w = viewport?.width ?? window.innerWidth;
      const h = viewport?.height ?? window.innerHeight;
      const height = Math.min(list.current!.scrollHeight, h - 16);
      const top = r.bottom + 8 + height <= y + h - 8 ? r.bottom + 8 : Math.max(y + 8, r.top - 8 - height);
      setPosition({ top, left: Math.max(x + 8, Math.min(r.right - 216, x + w - 224)), maxHeight: h - 16 });
    };
    place();
    list.current?.querySelector<HTMLElement>("button, a")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  const full = useSyncExternalStore(subscribeFullScreen, isFullScreen, () => false);
  useEffect(() => armSound(), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const choices = [...(list.current?.querySelectorAll<HTMLElement>("button, a") ?? [])];
        const i = choices.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1 : (i + (e.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
        choices[next]?.focus();
      }
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
      <button type="button" ref={trigger} className="cut cut-chip gmenu-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label="Game menu" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={list} id={id} role="menu" className="cut cut-card gmenu-list" style={position}>
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
        </div>, document.body
      )}
    </div>
  );
}
