"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { art } from "@/lib/art";
import { FxLayer } from "./burst";
import { isFullScreen, setFullScreen } from "./full-screen";

export type ArenaGame = "block-puzzle" | "holdem" | "trading-duel" | "vanguard";

/**
 * The stage a game sits on: a dark backdrop with colour at the edges and a quiet, dark centre, kept
 * inside the content column (the app shell is untouched). Paints `art.arena[game]` over a CSS
 * gradient per game, which shows if the art fails to load. Also mounts the `FxLayer` bursts draw on,
 * and owns full screen: `autoFull` turns it on (a live Match passes `autoFull={!ended}`, so it turns off again when
 * the Match ends), F toggles it (unless `fullScreenKey` is off, as in Hold'em where F folds), Esc leaves it, and
 * leaving the game leaves it.
 * `<Arena game="holdem">...the game...</Arena>`.
 */
export function Arena({ game, children, className = "", fullScreenKey = true, autoFull = false }: { game: ArenaGame; children: ReactNode; className?: string; fullScreenKey?: boolean; autoFull?: boolean }) {
  useEffect(() => {
    if (!autoFull) return;
    setFullScreen(true);
    return () => setFullScreen(false);
  }, [autoFull]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "f" || e.key === "F") && fullScreenKey) setFullScreen(!isFullScreen());
      else if (e.key === "Escape" && isFullScreen() && !t?.closest("dialog")) setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setFullScreen(false);
    };
  }, [fullScreenKey]);
  return (
    <div className={`fx-arena ${className}`} data-game={game} style={{ "--fx-arena-art": `url(${art.arena[game]})` } as CSSProperties}>
      <div className="fx-arena-bg" aria-hidden="true" />
      <div className="fx-arena-shade" aria-hidden="true" />
      <div className="fx-arena-body">{children}</div>
      <FxLayer />
    </div>
  );
}
