/**
 * Simulated yield, one rule on every chain (docs/yield-model.md): a Position earns
 * `principal * apy * simulated_elapsed / year`, linear on its own Principal, where
 * `simulated_elapsed = real_elapsed * speedup`. The LST exchange rate does not grow.
 * With `SPEEDUP` 4,380 one simulated month (1/12 year) is exactly 10 real minutes, so an Advance of
 * N months is repaid after N * 10 minutes: the Advance is the whole projected yield
 * (`principal * apy * N / 12`, ticket 31). The Yield Fee is taken when Gemas are cashed out (`cashOut`).
 */
export const SPEEDUP = 4380n;
export const YEAR_SECS = 31_536_000n;
export const BPS = 10_000n;
/** Tesoro's share of yield cashed out, used when the Treasury account cannot be read (CONTEXT.md: Yield Fee). */
export const DEFAULT_YIELD_FEE_BPS = 2_000;
/** What Tesoro keeps when it pays won Gemas now, used when the Treasury account cannot be read (CONTEXT.md: Instant Redeem Fee). */
export const DEFAULT_INSTANT_FEE_BPS = 2_500;
/** The fees and payouts as whole percentages of the Gemas' value, for static copy (docs, help). Live sheets read each Source's terms. */
export const YIELD_FEE_PCT = DEFAULT_YIELD_FEE_BPS / 100;
export const INSTANT_FEE_PCT = DEFAULT_INSTANT_FEE_BPS / 100;
/** A Redeem pays the value less the Yield Fee: 80%. */
export const REDEEM_PAYOUT_PCT = 100 - YIELD_FEE_PCT;
/** An Instant Redeem pays the value less the Yield Fee, then less the Instant Redeem Fee: 60%. */
export const INSTANT_PAYOUT_PCT = (REDEEM_PAYOUT_PCT * (100 - INSTANT_FEE_PCT)) / 100;
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

/** Projected yield an Advance of `months` is sized on: all of it, exactly as `Position::open_advance` (ticket 31). */
export const advanceUnits = (principal: bigint, rateBps: number, months: number): bigint =>
  (principal * BigInt(rateBps) * BigInt(months)) / (12n * BPS);

/** Where one cash-out goes (tesoro_core `ledger::yield_fee::CashOut`): `payout` to the one cashing out, `fee` to the Treasury, of which `pool` is owed to the Leaderboard Pool. */
export interface CashOut {
  payout: bigint;
  fee: bigint;
  pool: bigint;
}

/** The Yield Fee on `paid` cashed out, one floor (Rust `cash_out`): the payout is floored, the fee takes the rest. */
export function cashOut(paid: bigint, yieldFeeBps: number, poolBps: number): CashOut {
  const payout = (paid * (BPS - BigInt(yieldFeeBps))) / BPS;
  const fee = paid - payout;
  return { payout, fee, pool: (fee * BigInt(poolBps)) / BPS };
}

/** The Pool's share of the Instant Redeem Fee: always one fifth of it (founder, 2026-10-22). */
export const instantPoolBps = (instantFeeBps: number): number => Math.floor(instantFeeBps / 5);

/** The Treasury redeeming Gemas it bought (Rust `treasury_cash_out`): it keeps everything; the Pool is owed its fee half plus a fifth of the Instant fee on the after-fee value. */
export function treasuryCashOut(paid: bigint, yieldFeeBps: number, poolBps: number, instantFeeBps: number): CashOut {
  const c = cashOut(paid, yieldFeeBps, poolBps);
  return { ...c, pool: c.pool + (c.payout * BigInt(instantPoolBps(instantFeeBps))) / BPS };
}

/** What an Instant Redeem pays for Gemas worth `value` (tesoro_core `instant_payout`): the value after the Yield Fee and the Instant Redeem Fee, one floor. */
export const instantPayout = (value: bigint, instantFeeBps: number, yieldFeeBps: number): bigint =>
  (value * (BPS - BigInt(yieldFeeBps)) * (BPS - BigInt(instantFeeBps))) / (BPS * BPS);

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

/** `Principal * (growth - 1)` floored: the Accrued Yield, all of which counts toward Debt and free yield. */
export function accruedYieldAt(principal: bigint, growth: Growth): bigint {
  return growth.num > growth.den ? (principal * (growth.num - growth.den)) / growth.den : 0n;
}

/** What a native Position fixes at open: its Principal, rate and the time it opened (Unix seconds). */
export interface PositionClock {
  principal: bigint;
  rateBps: number;
  openedAt: number;
  /** Staking-token Positions (mainnet): the pool's Staking Rate at open, 1e12. Zero or absent for a simulated Position. */
  stakeRateOpen?: bigint;
  /** Staking-token Positions: the highest Staking Rate its yield was priced at (ticket 55); 0 or absent counts from `stakeRateOpen`. */
  stakeRateHigh?: bigint;
}

/**
 * Where a staking-token Position's growth comes from: the pool's Staking Rate `rateNow` read at `atSec`. An instant after
 * `atSec` is a projection at `apyBps` a year (the Advance sizing APY), used for estimates; at or before `atSec` it is exact.
 */
export interface StakeGrowth {
  rateNow: bigint;
  atSec: number;
  apyBps: number;
}

/** Growth since open of a staking-token Position at `nowSec`: `Staking Rate now / at open` (Rust `stake_growth`). */
export function stakeGrowthAt(rateOpen: bigint, stake: StakeGrowth | undefined, nowSec: number): Growth {
  if (!stake) return { num: rateOpen, den: rateOpen };
  const ahead = BigInt(Math.max(0, Math.floor(nowSec) - Math.floor(stake.atSec)));
  const rate = stake.rateNow + (stake.rateNow * BigInt(stake.apyBps) * ahead) / (BPS * YEAR_SECS);
  return { num: rate, den: rateOpen };
}

/**
 * Accrued Yield of a native Position at `nowSec`. A simulated Position takes only `speedup` from the sim_lst pool; a
 * staking-token Position (`stakeRateOpen` set) takes the pool's Staking Rate from `stake`, and without it shows no growth.
 */
export const positionAccrued = (p: PositionClock, speedup: number | bigint, nowSec: number, stake?: StakeGrowth): bigint =>
  p.stakeRateOpen
    ? accruedYieldAt(p.principal, countedStakeGrowth(p.stakeRateOpen, p.stakeRateHigh ?? 0n, stake, nowSec))
    : accruedYieldAt(p.principal, growthSinceOpen(p.rateBps, p.openedAt, nowSec, speedup));

/** Growth a staking-token Position counts (Rust `stake_position_counted`): never below the highest rate its yield was priced at. */
function countedStakeGrowth(rateOpen: bigint, rateHigh: bigint, stake: StakeGrowth | undefined, nowSec: number): Growth {
  const g = stakeGrowthAt(rateOpen, stake, nowSec);
  const peak = rateHigh > rateOpen ? rateHigh : rateOpen;
  return g.num < peak ? { num: peak, den: g.den } : g;
}

/**
 * Smallest `nowSec` at which a Position's Accrued Yield reaches `target` (null when it never will).
 * Starts from the closed form and steps over the floors, so it agrees with `positionAccrued` to the second.
 */
export function secondsUntilNet(p: PositionClock, speedup: number | bigint, target: bigint, stake?: StakeGrowth): number | null {
  if (p.stakeRateOpen) return secondsUntilStakeNet(p, target, stake);
  if (target <= 0n) return p.openedAt;
  const perSec = p.principal * BigInt(p.rateBps) * BigInt(speedup);
  if (perSec <= 0n) return null;
  let elapsed = (target * BPS * YEAR_SECS) / perSec;
  const net = (e: bigint) => positionAccrued(p, speedup, p.openedAt + Number(e));
  while (elapsed > 0n && net(elapsed - 1n) >= target) elapsed--;
  while (net(elapsed) < target) elapsed++;
  return p.openedAt + Number(elapsed);
}

/** Smallest second at which a staking-token Position's yield reaches `target`, projecting growth at `stake.apyBps` (null without growth to project). */
function secondsUntilStakeNet(p: PositionClock, target: bigint, stake?: StakeGrowth): number | null {
  if (!stake) return null;
  if (positionAccrued(p, 0, stake.atSec, stake) >= target) return stake.atSec;
  if (stake.apyBps <= 0) return null;
  let lo = stake.atSec;
  let hi = stake.atSec + 100 * 31_536_000;
  if (positionAccrued(p, 0, hi, stake) < target) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (positionAccrued(p, 0, mid, stake) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}
