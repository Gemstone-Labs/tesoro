/**
 * Simulated yield, one rule on every chain (docs/yield-model.md): a Position earns
 * `principal * apy * simulated_elapsed / year`, linear on its own Principal, where
 * `simulated_elapsed = real_elapsed * speedup`. The LST exchange rate does not grow.
 * With `SPEEDUP` 4,380 one simulated month (1/12 year) is exactly 10 real minutes, so an Advance of
 * N months is repaid after N * 10 minutes: the Advance is the projected yield net of the Yield Fee
 * (`principal * apy * N / 12 * (1 - fee)`) and the Position's vault only receives that net share.
 */
export const SPEEDUP = 4380n;
export const YEAR_SECS = 31_536_000n;
export const BPS = 10_000n;
/** Tesoro's share of every yield increment, used when the Treasury account cannot be read (CONTEXT.md: Yield Fee). */
export const DEFAULT_YIELD_FEE_BPS = 2_000;
/** What Tesoro keeps when it pays won Gemas now, used when the Treasury account cannot be read (CONTEXT.md: Instant Redeem Fee). */
export const DEFAULT_INSTANT_FEE_BPS = 2_500;
/** The Instant Redeem Fee and payout as whole percentages, for static copy (docs, help). Live sheets read the Treasury instead. */
export const INSTANT_FEE_PCT = DEFAULT_INSTANT_FEE_BPS / 100;
export const INSTANT_PAYOUT_PCT = 100 - INSTANT_FEE_PCT;
/** Real seconds one simulated month takes at `SPEEDUP`. */
export const MONTH_SECS = 600;

export function accruedYield(args: { principal: bigint; rateBps: number; elapsedSec: bigint; speedup?: bigint }): bigint {
  const { principal, rateBps, elapsedSec } = args;
  if (elapsedSec <= 0n) return 0n;
  return (principal * BigInt(rateBps) * elapsedSec * (args.speedup ?? SPEEDUP)) / (BPS * YEAR_SECS);
}

/** What a Position keeps of a yield increment (the program floors the fee, so rounding favours the Position). */
export const netOfYieldFee = (units: bigint, feeBps: number): bigint => units - (units * BigInt(feeBps)) / BPS;

/** Real seconds until a Position of `principal` has accrued `units` more yield net of the Yield Fee (null when it never will). */
export function secondsToAccrue(args: { principal: bigint; rateBps: number; units: bigint; speedup?: bigint; yieldFeeBps?: number }): number | null {
  if (args.units <= 0n) return 0;
  const keep = BPS - BigInt(args.yieldFeeBps ?? DEFAULT_YIELD_FEE_BPS);
  const perSec = args.principal * BigInt(args.rateBps) * (args.speedup ?? SPEEDUP) * keep;
  if (perSec <= 0n) return null;
  return Number((args.units * BPS * BPS * YEAR_SECS + perSec - 1n) / perSec);
}

/** Projected yield an Advance of `months` is sized on, net of the Yield Fee, exactly as `Position::open_advance`. */
export const advanceUnits = (principal: bigint, rateBps: number, months: number, yieldFeeBps: number): bigint =>
  (principal * BigInt(rateBps) * BigInt(months) * (BPS - BigInt(yieldFeeBps))) / (12n * BPS * BPS);

/** A Position's APY (percent) net of the Yield Fee: what it keeps of the yield it earns. */
export const netApyPct = (rateBps: number, feeBps: number): number => (rateBps * (10_000 - feeBps)) / 1_000_000;

/** The Instant Redeem rules of tesoro_core `instant_redeem`: `units` is the Gemas' full value, `payout` what is paid now. */
export const instantPayout = (units: bigint, instantFeeBps: number): bigint => (units * (BPS - BigInt(instantFeeBps))) / BPS;

// --- Accrued Yield computed on the spot (ADR 0010) -------------------------------------------------
// Mirrors programs/tesoro_core/src/ledger/yield_math.rs and ledger/native.rs. Nothing records yield:
// Debt and the amount a Gema redeems for are derived from the clock, so these bigint ports must match
// the Rust numbers exactly (shared fixtures in yield-math.fixtures.json).

/** Growth since a Position opened as the exact ratio `num / den` (mainnet will return `rate now / rate at open` through the same shape). */
export interface Growth {
  num: bigint;
  den: bigint;
}

/** Devnet growth since open: `1 + apy * (now - openedAt) * speedup / year`; one when `now` is before the open. */
export function growthSinceOpen(apyBps: number, openedAtSec: number, nowSec: number, speedup: number | bigint = SPEEDUP): Growth {
  const elapsed = BigInt(Math.max(0, Math.floor(nowSec) - Math.floor(openedAtSec)));
  const den = BPS * YEAR_SECS;
  return { num: den + BigInt(apyBps) * elapsed * BigInt(speedup), den };
}

export interface AccruedYield {
  gross: bigint;
  /** The Yield Fee, floored so rounding favours the Position. */
  fee: bigint;
  /** What counts toward Debt and free yield: `gross - fee`. */
  net: bigint;
}

/** `Principal * (growth - 1)` floored, then split by the Position's Yield Fee. */
export function accruedYieldAt(principal: bigint, growth: Growth, feeBps: number): AccruedYield {
  const gross = growth.num > growth.den ? (principal * (growth.num - growth.den)) / growth.den : 0n;
  const fee = (gross * BigInt(feeBps)) / BPS;
  return { gross, fee, net: gross - fee };
}

/** What a native Position fixes at open: its Principal, rate, Yield Fee and the time it opened (Unix seconds). */
export interface PositionClock {
  principal: bigint;
  rateBps: number;
  yieldFeeBps: number;
  openedAt: number;
}

/** Net Accrued Yield of a native Position at `nowSec`; only `speedup` is read live from the sim_lst pool. */
export const positionAccrued = (p: PositionClock, speedup: number | bigint, nowSec: number): AccruedYield =>
  accruedYieldAt(p.principal, growthSinceOpen(p.rateBps, p.openedAt, nowSec, speedup), p.yieldFeeBps);

/** The pool-wide totals behind the Treasury's Yield Fee claim (`NativeCustody`, Rust `PoolTotals`). */
export interface PoolTotals {
  feeWeight: bigint;
  feeWeightTime: bigint;
  realisedFee: bigint;
  openPositions: bigint;
}

/**
 * Yield Fee earned by the Treasury at `nowSec`, SOL units (Rust `PoolTotals::earned_fee`): conservative, never more than the sum of
 * the per-Position fees. Unminted until the Treasury pays out.
 */
export function earnedFee(t: PoolTotals, nowSec: number, speedup: number | bigint = SPEEDUP): bigint {
  const weighted = (t.feeWeight * BigInt(nowSec) - t.feeWeightTime) * BigInt(speedup);
  const live = weighted / (BPS * BPS * YEAR_SECS);
  const allowance = t.openPositions * 2n;
  return (live > allowance ? live - allowance : 0n) + t.realisedFee;
}

/**
 * Smallest `nowSec` at which a Position's net Accrued Yield reaches `target` (null when it never will).
 * Starts from the closed form and steps over the floors, so it agrees with `positionAccrued` to the second.
 */
export function secondsUntilNet(p: PositionClock, speedup: number | bigint, target: bigint): number | null {
  if (target <= 0n) return p.openedAt;
  const keep = BPS - BigInt(p.yieldFeeBps);
  const perSec = p.principal * BigInt(p.rateBps) * BigInt(speedup) * keep;
  if (perSec <= 0n) return null;
  let elapsed = (target * BPS * BPS * YEAR_SECS) / perSec;
  const net = (e: bigint) => positionAccrued(p, speedup, p.openedAt + Number(e)).net;
  while (elapsed > 0n && net(elapsed - 1n) >= target) elapsed--;
  while (net(elapsed) < target) elapsed++;
  return p.openedAt + Number(elapsed);
}
