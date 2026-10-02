import type { GameId } from "../mock/types";

/**
 * When a Match was opened, in ms since the epoch. Every Game's id embeds the opening time: Block
 * Puzzle and Hold'em as `ms * 2 + challenge`, Trading Duel as `ms * 8 + asset * 2 + challenge`
 * (the asset is bits 1 and 2, see games/trading-duel/chain.ts).
 */
export function matchOpenedAt(id: bigint, game: GameId | null): number {
  return Number(game === "trading-duel" ? id >> 3n : id >> 1n);
}

/** Trading Duel's asset index (0 SOL, 1 ETH, 2 HYPE) in a Match id: bits 1 and 2. */
export const assetIndexOf = (id: bigint): number => Number((id >> 1n) & 3n);

/** Asset query values of `/play/*?asset=`, by asset index. */
export const ASSET_PARAMS = ["sol", "eth", "hype"] as const;
export type AssetParam = (typeof ASSET_PARAMS)[number];

/** `?asset=` to an asset index; anything unknown is SOL. */
export const assetIndexFromParam = (v: string | string[] | null | undefined): 0 | 1 | 2 => {
  const i = ASSET_PARAMS.indexOf((Array.isArray(v) ? v[0] : v)?.toLowerCase() as AssetParam);
  return (i < 0 ? 0 : i) as 0 | 1 | 2;
};
