"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { art } from "@/lib/art";
import { FxLayer } from "./burst";
import { isFullScreen, setFullScreen, watchNativeExit } from "./full-screen";

export type ArenaGame = "block-puzzle" | "holdem" | "trading-duel";

/**
 * The stage a game sits on: a dark backdrop with colour at the edges and a quiet, dark centre, kept
 * inside the content column (the app shell is untouched). Paints `art.arena[game]` over a CSS
 * gradient per game, which shows if the art fails to load. Also mounts the `FxLayer` bursts draw on,
 * and owns full screen: F toggles it, Esc leaves it, and leaving the game leaves it.
 * `<Arena game="holdem">...the game...</Arena>`.
 */
export function Arena({ game, children, className = "" }: { game: ArenaGame; children: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "f" || e.key === "F") setFullScreen(!isFullScreen());
      else if (e.key === "Escape" && isFullScreen() && !t?.closest("dialog")) setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    const unwatch = watchNativeExit();
    return () => {
      window.removeEventListener("keydown", onKey);
      unwatch();
      setFullScreen(false);
    };
  }, []);
  return (
    <div className={`fx-arena ${className}`} data-game={game} style={{ "--fx-arena-art": `url(${art.arena[game]})` } as CSSProperties}>
      <div className="fx-arena-bg" aria-hidden="true" />
      <div className="fx-arena-shade" aria-hidden="true" />
      <div className="fx-arena-body">{children}</div>
      <FxLayer />
    </div>
  );
}
