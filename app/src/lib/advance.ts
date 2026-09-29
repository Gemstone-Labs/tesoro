import { GEMA_USD_AT_ISSUANCE } from "./format";
import type { Asset, Position } from "./mock/types";

/** Example asset prices in USD, fixed for the mock. */
export const ASSET_USD: Record<Asset, number> = { SOL: 150, ETH: 3000, HYPE: 40 };

/** Simulated yield: 1 month = 10 minutes of wall clock. */
export const SIM_MINUTES_PER_MONTH = 10;

export interface AdvanceQuote {
  horizonMonths: number;
  projectedYield: number;
  gemasIssued: number;
  unlockEstimate: string;
}

/** An Advance is 100% of the Position's projected yield over the Horizon. */
export function quoteAdvance(position: Position, horizonMonths: number, now: string): AdvanceQuote {
  const projectedYield = (position.principal * position.apy * horizonMonths) / 12;
  const gemasIssued = Math.floor(
    (projectedYield * ASSET_USD[position.asset]) / GEMA_USD_AT_ISSUANCE,
  );
  const unlock = new Date(new Date(now).getTime() + horizonMonths * SIM_MINUTES_PER_MONTH * 60_000);
  return { horizonMonths, projectedYield, gemasIssued, unlockEstimate: unlock.toISOString() };
}

/** Asset amount a number of Gemas redeems for, at the Source asset's price. */
export function gemasToAsset(gemas: number, asset: Asset): number {
  return (gemas * GEMA_USD_AT_ISSUANCE) / ASSET_USD[asset];
}
