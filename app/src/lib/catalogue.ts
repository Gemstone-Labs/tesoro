import { art } from "./art";
import type { GameId } from "./mock/types";

export interface CatalogueEntry {
  key: string;
  name: string;
  tile: string;
  /** Playable today. Coming-soon entries are dimmed and not clickable. */
  live: boolean;
  game?: GameId;
}

/** The order the Lobby shows the live Games in, in the hero carousel and the Play Now grid (founder pick). */
export const LOBBY_ORDER: GameId[] = ["vanguard", "holdem", "trading-duel", "block-puzzle"];

/** The Lobby's Play Now rail: the live Games, then the announced ones. */
export const CATALOGUE: CatalogueEntry[] = [
  { key: "vanguard", name: "Vanguard", tile: art.vanguardTile, live: true, game: "vanguard" },
  { key: "holdem", name: "Heads-up Hold'em", tile: art.holdemTile, live: true, game: "holdem" },
  { key: "trading-duel", name: "Trading Duel", tile: art.tradingDuelTile, live: true, game: "trading-duel" },
  { key: "block-puzzle", name: "Block Puzzle", tile: art.blockPuzzleTile, live: true, game: "block-puzzle" },
  { key: "word-duel", name: "Word Duel", tile: art.comingSoon["word-duel"], live: false },
  { key: "bubble-burst", name: "Bubble Burst", tile: art.comingSoon["bubble-burst"], live: false },
  { key: "pocket-pool", name: "Pocket Pool", tile: art.comingSoon["pocket-pool"], live: false },
  { key: "trivia-sprint", name: "Trivia Sprint", tile: art.comingSoon["trivia-sprint"], live: false },
];

/** "2m ago" / "4h ago" / "1d ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
