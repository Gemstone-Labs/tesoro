import type { CSSProperties, ReactNode } from "react";
import { art } from "@/lib/art";
import { FxLayer } from "./burst";

export type ArenaGame = "block-puzzle" | "holdem" | "trading-duel";

/**
 * The stage a game sits on: a dark backdrop with colour at the edges and a quiet, dark centre, kept
 * inside the content column (the app shell is untouched). Paints `art.arena[game]` over a CSS
 * gradient per game, which shows if the art fails to load. Also mounts the `FxLayer` bursts draw on.
 * `<Arena game="holdem">...the game...</Arena>`.
 */
export function Arena({ game, children, className = "" }: { game: ArenaGame; children: ReactNode; className?: string }) {
  return (
    <div className={`fx-arena ${className}`} data-game={game} style={{ "--fx-arena-art": `url(${art.arena[game]})` } as CSSProperties}>
      <div className="fx-arena-bg" aria-hidden="true" />
      <div className="fx-arena-shade" aria-hidden="true" />
      <div className="fx-arena-body">{children}</div>
      <FxLayer />
    </div>
  );
}
