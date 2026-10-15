import { DEFAULT_YIELD_FEE_BPS } from "./chain/yield";
import { GEMA_USD_AT_ISSUANCE } from "./format";
import type { Asset, Position } from "./mock/types";

/** Example asset prices in USD, fixed for the mock. */
export const ASSET_USD: Record<Asset, number> = { SOL: 150, ETH: 3000, HYPE: 40 };

/** Simulated yield: 1 month = 10 minutes of wall clock. */
export const SIM_MINUTES_PER_MONTH = 10;

/** Horizon every Open a Position and Take an Advance form starts at, in months. */
export { DEFAULT_HORIZON_MONTHS } from "./cluster-settings";

export interface AdvanceQuote {
  horizonMonths: number;
  projectedYield: number;
  gemasIssued: number;
  unlockEstimate: string;
}

/** An Advance is the Position's projected yield over the Horizon, net of the Yield Fee. */
export function quoteAdvance(position: Position, horizonMonths: number, now: string): AdvanceQuote {
  const projectedYield = (position.principal * position.apy * horizonMonths * (10_000 - DEFAULT_YIELD_FEE_BPS)) / (12 * 10_000);
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

/** Extend an open Advance needs the `extend_native_advance` upgrade on tesoro_core: the action shows only once this is set. */
export const EXTEND_ADVANCE_ENABLED = process.env.NEXT_PUBLIC_EXTEND_ADVANCE === "1";
