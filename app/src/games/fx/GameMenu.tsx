"use client";

import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { GameActions, type GameActionsProps } from "./GameActions";
import { armSound } from "./sfx";
import "./game-menu.css";

export type { GameMenuItem } from "./GameActions";

/**
 * The one control a game screen keeps besides its own: a ⋯ button whose menu holds sound, full screen, the game's own
 * items (How to play, Hand log) and Leave. The list is portalled out of cut cards so their clip-path cannot clip it.
 */
export function GameMenu({ items, leaveHref, className = "" }: GameActionsProps & { className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const id = useId();
  useEffect(() => armSound(), []);
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

  return (
    <div className={`gmenu ${className}`} ref={root}>
      <button type="button" ref={trigger} className="cut cut-chip gmenu-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label="Game menu" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={list} id={id} role="menu" className="cut cut-card gmenu-list" style={position}>
          <GameActions items={items} leaveHref={leaveHref} menu onSelect={() => setOpen(false)} />
        </div>, document.body
      )}
    </div>
  );
}
