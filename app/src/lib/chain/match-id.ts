import { PublicKey } from "@solana/web3.js";
import { matchPda } from "./basket";
import { matchKeyOf, parseMatchKey } from "../../server/history/match-key";

/**
 * A Match is named by its opener's Account and the opener's counter value, `<opener>-<n>` in URLs and the
 * history tables (the key never contains anything but base58 and one "-"). Everything else a Match used to
 * hide in its id (Challenge, Trading Duel asset, opening time) is a field of `MatchState`.
 */
export { matchKeyOf, parseMatchKey };
export type { MatchKey } from "../../server/history/match-key";

/** The on-chain address of the Match a URL segment or table key names, or null when it is not a Match key. */
export function matchAddressOf(key: string): PublicKey | null {
  const k = parseMatchKey(key);
  if (!k) return null;
  try {
    return matchPda(new PublicKey(k.opener), k.n);
  } catch {
    return null;
  }
}

/** Asset query values of `/play/*?asset=`, by asset index. */
export const ASSET_PARAMS = ["sol", "eth", "hype"] as const;
export type AssetParam = (typeof ASSET_PARAMS)[number];

/** `?asset=` to an asset index; anything unknown is SOL. */
export const assetIndexFromParam = (v: string | string[] | null | undefined): 0 | 1 | 2 => {
  const i = ASSET_PARAMS.indexOf((Array.isArray(v) ? v[0] : v)?.toLowerCase() as AssetParam);
  return (i < 0 ? 0 : i) as 0 | 1 | 2;
};
