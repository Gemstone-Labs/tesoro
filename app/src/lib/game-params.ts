import type { GameId } from "./mock/types";
import { ASSET_PARAMS, assetIndexFromParam } from "./chain/match-id";

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v);

/** The `?game=` of a play link; Block Puzzle when absent or unknown. */
export function gameFromParam(v: Param): GameId {
  const g = first(v);
  return g === "holdem" || g === "trading-duel" ? g : "block-puzzle";
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
