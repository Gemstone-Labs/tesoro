"use client";

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { art } from "@/lib/art";
import { FxLayer } from "./burst";
import { createCoverSession, isFullScreen, setFullScreen } from "./full-screen";

export type ArenaGame = "block-puzzle" | "holdem" | "trading-duel" | "vanguard";
const ArenaSession = createContext<(() => void) | null>(null);

/**
 * The game's backdrop and window cover (never the browser Fullscreen API). `autoFull` enters once;
 * the cover stays through the end panel until the Player toggles it off or leaves the Arena.
 * A route can own an Arena so replacing the board with a Match result keeps the same cover.
 * Nested Arenas share that owner. F toggles the cover; Esc leaves it.
 */
export function Arena({ game, children, className = "", autoFull = false }: { game: ArenaGame; children: ReactNode; className?: string; autoFull?: boolean }) {
  const parent = useContext(ArenaSession);
  const [session] = useState(createCoverSession);
  const enter = session.enter;
  useEffect(() => {
    if (autoFull) (parent ?? enter)();
  }, [autoFull, parent, enter]);
  useEffect(() => {
    if (parent) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable], dialog, [role=dialog]")) return;
      if (document.querySelector("dialog[open], [aria-modal=true]")) return;
      if (e.key === "f" || e.key === "F") setFullScreen(!isFullScreen());
      else if (e.key === "Escape" && isFullScreen()) setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      session.leave();
    };
  }, [parent, session]);
  if (parent) return <>{children}</>;
  return (
    <ArenaSession value={enter}>
      <div className={`fx-arena ${className}`} data-game={game} style={{ "--fx-arena-art": `url(${art.arena[game]})` } as CSSProperties}>
        <div className="fx-arena-bg" aria-hidden="true" />
        <div className="fx-arena-shade" aria-hidden="true" />
        <div className="fx-arena-body">{children}</div>
        <FxLayer />
      </div>
    </ArenaSession>
  );
}
