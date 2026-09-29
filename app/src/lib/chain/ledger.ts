/**
 * Pure bigint ports of the read-side money rules in programs/tesoro_core/src/ledger/money.rs
 * (Source math, redeemable split, entry draw plan). No Solana imports so they are unit-testable.
 */

export interface SourceMath {
  issued: bigint;
  returned: bigint;
  redeemed: bigint;
  yieldUnits: bigint;
  /** Source-asset base units per Gema is `unitNum / unitDen`. */
  unitNum: bigint;
  unitDen: bigint;
}

const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export const live = (s: SourceMath) => sat(s.issued, s.returned);

/** Gemas repaid by accrued yield. */
export function covered(s: SourceMath): bigint {
  if (s.unitNum === 0n) return 0n;
  return min((s.yieldUnits * s.unitDen) / s.unitNum, live(s));
}

/** Outstanding Gemas of this Source not yet repaid by yield. */
export const debtGemas = (s: SourceMath) => sat(live(s), covered(s));

/** Debt in source-asset base units, rounded up (as the program does). */
export function debtUnits(s: SourceMath): bigint {
  if (s.unitDen === 0n) return 0n;
  return (debtGemas(s) * s.unitNum + s.unitDen - 1n) / s.unitDen;
}

/** Gemas held by anyone or escrowed in Pots. */
export const outstanding = (s: SourceMath) => sat(live(s), s.redeemed);

/** Repaid but not yet redeemed, in Gemas. */
export const redeemable = (s: SourceMath) => sat(covered(s), s.redeemed);

/** What a holder of `held` free Gemas may redeem now: their pro rata share. */
export function redeemableFor(s: SourceMath, held: bigint): bigint {
  const out = outstanding(s);
  if (out === 0n) return 0n;
  return min((held * redeemable(s)) / out, held);
}

/** Source-asset units still needed from yield to repay everything live (rounded up). */
export function unitsToRepay(s: SourceMath): bigint {
  if (s.unitDen === 0n) return 0n;
  const total = (live(s) * s.unitNum + s.unitDen - 1n) / s.unitDen;
  return sat(total, s.yieldUnits);
}

export interface EntryHolding {
  /** Source address bytes: the canonical order is ascending by these. */
  source: Uint8Array;
  isOwn: boolean;
  /** amount - reserved */
  free: bigint;
}

export class EntryError extends Error {
  constructor(readonly code: "insufficient" | "too-many-sources") {
    super(code === "insufficient" ? "Not enough Gemas for this entry" : "Entry would draw on more than 2 Sources");
  }
}

export const MAX_ENTRY_SOURCES = 2;

export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Picks the Holdings an entry draws on, in the order tesoro_core requires: own-sourced class
 * first, then won, each strictly ascending by Source, each class drained in that order.
 * Returns indices into `holdings`.
 */
export function planEntry(entry: bigint, holdings: EntryHolding[]): number[] {
  const ownFree = holdings.filter((h) => h.isOwn).reduce((s, h) => s + h.free, 0n);
  const wonFree = holdings.filter((h) => !h.isOwn).reduce((s, h) => s + h.free, 0n);
  const ownNeed = min(entry, ownFree);
  const wonNeed = entry - ownNeed;
  if (wonNeed > wonFree) throw new EntryError("insufficient");
  const picked: number[] = [];
  for (const [isOwn, need] of [
    [true, ownNeed],
    [false, wonNeed],
  ] as const) {
    let left = need;
    const idx = holdings
      .map((h, i) => [h, i] as const)
      .filter(([h]) => h.isOwn === isOwn && h.free > 0n)
      .sort(([a], [b]) => compareKeys(a.source, b.source));
    for (const [h, i] of idx) {
      if (left === 0n) break;
      picked.push(i);
      left -= min(left, h.free);
    }
  }
  if (picked.length > MAX_ENTRY_SOURCES) throw new EntryError("too-many-sources");
  return picked;
}

/** Fee taken from the Pot at settlement, in Gemas (each share floored, as in the ledger). */
export function feeGemas(entry: bigint, platformBps: number, studioBps: number): bigint {
  const pot = entry * 2n;
  return (pot * BigInt(platformBps)) / 10_000n + (pot * BigInt(studioBps)) / 10_000n;
}

/** Gemas won or lost at settlement, net of Fees. Refunds and draws are 0. */
export function matchDelta(m: {
  seat: 0 | 1 | null;
  entry: number;
  fees: { platformBps: number; studioBps: number };
  session: { settled: boolean; result: "opener" | "joiner" | "draw" } | null;
}): number {
  if (!m.session?.settled || m.seat === null || m.session.result === "draw") return 0;
  const won = (m.session.result === "opener") === (m.seat === 0);
  if (!won) return -m.entry;
  return m.entry - Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps));
}
