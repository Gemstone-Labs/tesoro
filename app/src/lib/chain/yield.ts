/**
 * Simulated yield, one rule on every chain (docs/yield-model.md): a Position earns
 * `principal * apy * simulated_elapsed / year`, linear on its own Principal, where
 * `simulated_elapsed = real_elapsed * speedup`. The LST exchange rate does not grow.
 * With `SPEEDUP` 4,380 one simulated month (1/12 year) is exactly 10 real minutes, so an Advance of
 * N months (`principal * apy * N / 12`) is repaid after N * 10 minutes.
 */
export const SPEEDUP = 4380n;
export const YEAR_SECS = 31_536_000n;
export const BPS = 10_000n;
/** Real seconds one simulated month takes at `SPEEDUP`. */
export const MONTH_SECS = 600;

export function accruedYield(args: { principal: bigint; rateBps: number; elapsedSec: bigint; speedup?: bigint }): bigint {
  const { principal, rateBps, elapsedSec } = args;
  if (elapsedSec <= 0n) return 0n;
  return (principal * BigInt(rateBps) * elapsedSec * (args.speedup ?? SPEEDUP)) / (BPS * YEAR_SECS);
}

/** Real seconds until a Position of `principal` has accrued `units` more yield (null when it never will). */
export function secondsToAccrue(args: { principal: bigint; rateBps: number; units: bigint; speedup?: bigint }): number | null {
  if (args.units <= 0n) return 0;
  const perSec = args.principal * BigInt(args.rateBps) * (args.speedup ?? SPEEDUP);
  if (perSec <= 0n) return null;
  return Number((args.units * BPS * YEAR_SECS + perSec - 1n) / perSec);
}
