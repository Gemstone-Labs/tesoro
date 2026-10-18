import type { GameId } from "./mock/types";
import { isGameId } from "./games";
import { ASSET_PARAMS, assetIndexFromParam } from "./chain/match-id";

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v);

/** The `?game=` of a play link; Block Puzzle when absent or unknown. */
export function gameFromParam(v: Param): GameId {
  const g = first(v);
  return isGameId(g) ? g : "block-puzzle";
}

/** Trading Duel's asset index from `?asset=sol|eth|hype` (SOL when absent). */
export const assetFromParam = (v: Param): 0 | 1 | 2 => assetIndexFromParam(first(v));

/**
 * The query prefix a play link carries for a Game: "" for Block Puzzle, `game=holdem&`, or
 * `game=trading-duel&asset=eth&`. Always ends with `&` when not empty, so `entry=` can follow.
 */
export function gameQuery(game: GameId, asset?: number | null): string {
  if (game === "block-puzzle") return "";
  if (game === "trading-duel") return `game=trading-duel&asset=${ASSET_PARAMS[asset ?? 0] ?? "sol"}&`;
  return `game=${game}&`;
}

/** The query of an accepted Backing's Queue or Challenge link: game and asset, entry, and the Offer funding it. */
export function backingQuery(game: GameId, asset: number | null | undefined, entry: number, offer: string): string {
  return `${gameQuery(game, asset)}entry=${entry}&backing=${offer}`;
}

/** The free practice page of a Game (Trading Duel carries the chosen asset). */
export function practiceHref(game: GameId, asset?: number | null): string {
  if (game === "block-puzzle") return "/play/practice";
  return `/play/practice?${gameQuery(game, asset).replace(/&$/, "")}`;
}

/** The Challenge link of a Game at the default entry (Trading Duel carries the chosen asset). */
export function challengeHref(game: GameId, asset?: number | null): string {
  return `/play/challenge${game === "block-puzzle" ? "" : `?${gameQuery(game, asset).replace(/&$/, "")}`}`;
}
