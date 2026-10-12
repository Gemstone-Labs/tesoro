import type { Asset } from "./chain";
import { midToUsd } from "./feed";

/** USD with the precision the asset warrants (HYPE and SOL show cents, ETH too; everything shows at least 2 decimals). */
export function usd(v: number, asset?: Asset, digitsOverride?: number): string {
  const digits = digitsOverride ?? (asset?.symbol === "ETH" ? 2 : v < 1 ? 4 : 2);
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const usdMid = (mid: bigint, asset?: Asset): string => usd(midToUsd(mid), asset);
