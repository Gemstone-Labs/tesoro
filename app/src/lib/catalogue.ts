import { art } from "./art";
import type { GameId } from "./mock/types";

export type Category = "puzzle" | "cards" | "head-to-head" | "async";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "puzzle", label: "Puzzle" },
  { id: "cards", label: "Cards" },
  { id: "head-to-head", label: "Head-to-head" },
  { id: "async", label: "Async" },
];

export interface CatalogueEntry {
  key: string;
  name: string;
  tags: Category[];
  tile: string;
  /** Wide art for the big /play card when the square tile crops badly there, shown right-aligned. */
  wide?: string;
  /** Playable today. Coming-soon entries are dimmed and not clickable. */
  live: boolean;
  game?: GameId;
}

/** The Lobby's Play Now rail: the three live Games first, then the announced ones. */
export const CATALOGUE: CatalogueEntry[] = [
  { key: "block-puzzle", name: "Block Puzzle", tags: ["puzzle", "async", "head-to-head"], tile: art.blockPuzzleTile, live: true, game: "block-puzzle" },
  { key: "holdem", name: "Heads-up Hold'em", tags: ["cards", "head-to-head"], tile: art.holdemTile, live: true, game: "holdem" },
  { key: "trading-duel", name: "Trading Duel", tags: ["head-to-head"], tile: art.tradingDuelTile, wide: art.tradingDuelHero, live: true, game: "trading-duel" },
  { key: "word-duel", name: "Word Duel", tags: ["puzzle", "head-to-head"], tile: art.comingSoon["word-duel"], live: false },
  { key: "bubble-burst", name: "Bubble Burst", tags: ["puzzle", "async"], tile: art.comingSoon["bubble-burst"], live: false },
  { key: "pocket-pool", name: "Pocket Pool", tags: ["head-to-head"], tile: art.comingSoon["pocket-pool"], live: false },
  { key: "trivia-sprint", name: "Trivia Sprint", tags: ["head-to-head", "async"], tile: art.comingSoon["trivia-sprint"], live: false },
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
