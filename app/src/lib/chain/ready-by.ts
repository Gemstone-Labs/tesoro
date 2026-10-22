/**
 * What the Wallet says about speed: how many Gemas are ready, and for the rest, when their Lock's
 * planned repayment date falls ("ready by"). The date is the line's planned repayment (`dueAt`, the
 * same date the entry draw orders by), not a promise: a Lock that earns slower repays later.
 */

import type { ChainHolding } from "./read";

type LineView = Pick<ChainHolding, "amount" | "redeemable" | "dueAt" | "classId">;

export interface ReadyBy {
  /** Whole Gemas Redeem pays now. */
  now: bigint;
  /** Gemas still waiting on yield. */
  waiting: bigint;
  /** Unix seconds when the soonest waiting Gemas are planned to be ready; null when nothing waits. */
  next: number | null;
  /** Unix seconds when the last waiting Gemas are planned to be ready. */
  last: number | null;
  /** Waiting Gemas by planned date, soonest first, at most `maxRows` rows (later dates fold into the last row). */
  rows: { at: number; gemas: bigint }[];
}

const DAY = 86_400;

/** Playable lines only (fee classes are not the Player's Gemas to spend). */
export function readyBy(lines: LineView[], nowSec: number, maxRows = 3): ReadyBy {
  let now = 0n;
  let waiting = 0n;
  const byDay = new Map<number, bigint>();
  for (const l of lines) {
    if (l.classId < 3) continue;
    now += l.redeemable;
    const rest = l.amount - l.redeemable;
    if (rest <= 0n) continue;
    waiting += rest;
    // a date in the past means "any moment now": it counts as today
    const day = Math.floor(Math.max(l.dueAt, nowSec) / DAY) * DAY;
    byDay.set(day, (byDay.get(day) ?? 0n) + rest);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  const rows = days.slice(0, maxRows).map(([at, gemas]) => ({ at, gemas }));
  if (days.length > maxRows) {
    const folded = days.slice(maxRows - 1);
    rows[maxRows - 1] = { at: folded[folded.length - 1][0], gemas: folded.reduce((s, [, g]) => s + g, 0n) };
  }
  return { now, waiting, next: days.length ? days[0][0] : null, last: days.length ? days[days.length - 1][0] : null, rows };
}

/** Lines at most this many Gemas are "small leftovers" ($0.25): a line's rent costs more than that. */
export const SMALL_LEFTOVER_GEMAS = 25n;

/** Lines worth tidying: small, with something to Redeem. Redeeming them frees their slots. */
export const smallLeftovers = <T extends Pick<ChainHolding, "amount" | "redeemable" | "classId">>(lines: T[], max: bigint = SMALL_LEFTOVER_GEMAS): T[] =>
  lines.filter((l) => l.classId >= 3 && l.amount <= max && l.redeemable > 0n);

/**
 * The cost of paying a Redeem out on ETH or HYPE: the cross-chain message fee (paid in SOL on
 * Solana) against what the Redeem pays. `feeLamports` from the bridge quote, `solMicroUsd` the SOL
 * price; 1 Gema = $0.01.
 */
export interface RedeemCost {
  usd: number;
  /** The cost in Gemas, rounded up. */
  gemas: number;
  /** Cost over value, 0 to 1+ (1 = it costs as much as it pays). */
  share: number;
  /** The cost is a big part of the payout: waiting to redeem more at once is cheaper. */
  small: boolean;
}

export function redeemCost(args: { feeLamports: bigint; solMicroUsd: bigint; redeemGemas: bigint; smallShare?: number }): RedeemCost {
  const usd = Number((args.feeLamports * args.solMicroUsd) / 1_000_000_000n) / 1_000_000;
  const value = Number(args.redeemGemas) * 0.01;
  const share = value > 0 ? usd / value : usd > 0 ? Infinity : 0;
  return { usd, gemas: Math.ceil(usd / 0.01), share, small: share >= (args.smallShare ?? 0.1) };
}
