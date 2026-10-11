import type { CSSProperties, ReactNode } from "react";
import { art } from "@/lib/art";
import { FxLayer } from "./burst";

export type ArenaGame = "block-puzzle" | "holdem" | "trading-duel";

/**
 * The stage a game sits on: a dark backdrop with colour at the edges and a quiet, dark centre, kept
 * inside the content column (the app shell is untouched). Uses `art.arena[game]` when the Astra art
 * exists, otherwise a CSS gradient per game. Also mounts the `FxLayer` bursts draw on.
 * `<Arena game="holdem">...the game...</Arena>`.
 */
export function Arena({ game, children, className = "" }: { game: ArenaGame; children: ReactNode; className?: string }) {
  const src = art.arena[game];
  return (
    <div className={`fx-arena ${className}`} data-game={game} style={src ? ({ "--fx-arena-art": `url(${src})` } as CSSProperties) : undefined}>
      <div className={`fx-arena-bg${src ? " art" : ""}`} aria-hidden="true" />
      <div className="fx-arena-shade" aria-hidden="true" />
      <div className="fx-arena-body">{children}</div>
      <FxLayer />
    </div>
  );
}
