/**
 * Pure bigint ports of the read-side money rules in programs/tesoro_core/src/ledger/money.rs
 * (Source math, redeemable split, entry draw plan). No Solana imports so they are unit-testable.
 */

import { LEADERBOARD_BPS } from "./season";

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

/**
 * Instant Redeem split of `free` won Gemas, as the program allows it: Redeem pays `landed` in full first, then `pending` is the
 * most the Treasury may buy (Gemas whose yield has not landed). A holder that redeems nothing first can sell `free - redeemableFor`.
 */
export function instantSplit(s: SourceMath, free: bigint): { landed: bigint; pending: bigint } {
  const landed = redeemableFor(s, free);
  const held = free - landed;
  return { landed, pending: held - redeemableFor({ ...s, redeemed: s.redeemed + landed }, held) };
}

/** Whole Source-asset units `gemas` are worth at the Source's Advance price (1 Gema = $0.01, `unitDen` = price in micro-USD). */
export function gemasInAsset(gemas: bigint, s: Pick<SourceMath, "unitDen">): number {
  return s.unitDen === 0n ? 0 : (Number(gemas) * 10_000) / Number(s.unitDen);
}

/** Source-asset units still needed from yield to repay everything live (rounded up). */
export function unitsToRepay(s: SourceMath): bigint {
  if (s.unitDen === 0n) return 0n;
  const total = (live(s) * s.unitNum + s.unitDen - 1n) / s.unitDen;
  return sat(total, s.yieldUnits);
}

/** Source-asset units of accrued yield that repay every live Gema, rounded up (Rust `units_to_repay_total`). */
export function unitsToRepayTotal(s: SourceMath): bigint {
  if (s.unitDen === 0n) return 0n;
  return (live(s) * s.unitNum + s.unitDen - 1n) / s.unitDen;
}

/**
 * Debt and redeemable of a Source at the clock (Rust `source_now`): the Position's net Accrued Yield past `appliedBefore`
 * counts, up to what the Source still owes. Returns the Source with the yield a crank would have stored, and the rest as free yield.
 */
export function sourceNow(s: SourceMath, netAccrued: bigint, appliedBefore: bigint): { source: SourceMath; freeUnits: bigint } {
  const counted = sat(netAccrued, appliedBefore);
  const units = min(counted, unitsToRepayTotal(s));
  return { source: { ...s, yieldUnits: units }, freeUnits: counted - units };
}

/** What the Position fixes about its yield checkpoint: the open Advance and the net yield already settled (Rust `source_view`). */
export interface NativeCheckpoint {
  openAdvance: number | null;
  appliedNet: bigint;
}

/**
 * The Source as it stands at net Accrued Yield `net`: the open Advance gets its derived `yieldUnits`
 * (never below what is stored); a closed Source is as stored.
 */
export function sourceView(p: NativeCheckpoint, index: number, s: SourceMath, net: bigint): SourceMath {
  if (p.openAdvance !== index) return s;
  const view = sourceNow(s, net, p.appliedNet).source;
  return { ...view, yieldUnits: view.yieldUnits > s.yieldUnits ? view.yieldUnits : s.yieldUnits };
}

/** The entry itself is planned in draw.ts (`planDraw`): an entry has no Source limit any more, a long one goes through a Ticket. */
export { DrawError as EntryError } from "./draw";

/**
 * Fee taken from the Pot at settlement, in Gemas (each share floored, as in the ledger): Platform, Studio and the
 * Leaderboard Fee (the Match does not store that one: pass what it was charged, see `leaderboardBpsFor`; 0 when omitted).
 */
export function feeGemas(entry: bigint, platformBps: number, studioBps: number, leaderboardBps = 0): bigint {
  const pot = entry * 2n;
  return (pot * BigInt(platformBps)) / 10_000n + (pot * BigInt(studioBps)) / 10_000n + (pot * BigInt(leaderboardBps)) / 10_000n;
}

/** Total Fee of a Match, in Gemas: all three Fees from its terms. */
export function matchFee(m: { entry: number; fees: { platformBps: number; studioBps: number; leaderboardBps?: number } }): number {
  return Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps, m.fees.leaderboardBps));
}

/** What a win pays at the display Fees (2% Platform, 3% Studio, 1% Leaderboard): both entries minus Fees. */
export function estimatedWin(entry: number): number {
  return entry * 2 - Number(feeGemas(BigInt(entry), 200, 300, LEADERBOARD_BPS));
}

export interface BackedSplit {
  fees: number;
  /** What the loser's entry leaves after Fees: the amount the Offer splits. */
  surplus: number;
  playerShare: number;
  backerEntryBack: number;
  backerSurplus: number;
  /** Gemas the Backer gains (+) or loses (-) against before the Backing. */
  backerNet: number;
  /** Gemas the backed Player gains. Never negative: a backed Player is never debited. */
  playerNet: number;
}

/** The Backing settlement rule (tesoro_core `win_payouts`): Backer's entry back first, then the Offer's split of the surplus. */
export function backedSplit(a: { entry: number; platformBps: number; studioBps: number; leaderboardBps?: number; shareBps: number; won: boolean }): BackedSplit {
  if (!a.won) {
    return { fees: 0, surplus: 0, playerShare: 0, backerEntryBack: 0, backerSurplus: 0, backerNet: -a.entry, playerNet: 0 };
  }
  const fees = Number(feeGemas(BigInt(a.entry), a.platformBps, a.studioBps, a.leaderboardBps));
  const surplus = a.entry - fees;
  const playerShare = Number((BigInt(surplus) * BigInt(a.shareBps)) / 10_000n);
  const backerSurplus = surplus - playerShare;
  return { fees, surplus, playerShare, backerEntryBack: a.entry, backerSurplus, backerNet: backerSurplus, playerNet: playerShare };
}

type Outcome = { session: { settled: boolean; result: "opener" | "joiner" | "draw" } | null; winner?: "opener" | "joiner" | null };
const outcomeOf = (m: Outcome) => (m.session ? (m.session.settled ? m.session.result : null) : (m.winner ?? null));

/**
 * How one seat fared at settlement, from the result alone (never from the Gema change: a backed
 * Player's loss and a 0% share win both move 0 Gemas). Null until there is a result.
 */
export function seatResult(m: Outcome, seat: 0 | 1): "won" | "lost" | "draw" | null {
  const result = outcomeOf(m);
  if (!result) return null;
  if (result === "draw") return "draw";
  return (result === "opener") === (seat === 0) ? "won" : "lost";
}

/**
 * Gemas won or lost at settlement, net of Fees. Refunds and draws are 0. Block Burst settles from
 * its Session; Hold'em has none, so a settled table's winner comes in as `winner`. A backed Player
 * (`backing`) only ever gains their share of the surplus and loses nothing.
 */
export function matchDelta(
  m: Outcome & {
    seat: 0 | 1 | null;
    entry: number;
    fees: { platformBps: number; studioBps: number; leaderboardBps?: number };
    backing?: { shareBps: number } | null;
  },
): number {
  const result = m.seat === null ? null : seatResult(m, m.seat);
  if (result === null || result === "draw") return 0;
  const won = result === "won";
  if (m.backing) return backedSplit({ entry: m.entry, ...m.fees, shareBps: m.backing.shareBps, won }).playerNet;
  if (!won) return -m.entry;
  return m.entry - Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps, m.fees.leaderboardBps));
}

/** The Backer's result of a Match they funded: the split on a win, the entry on a loss, 0 on a draw or refund. */
export function backerDelta(
  m: Outcome & { backerSeat: 0 | 1; entry: number; fees: { platformBps: number; studioBps: number }; shareBps: number },
): number {
  const result = seatResult(m, m.backerSeat);
  if (result === null || result === "draw") return 0;
  return backedSplit({ entry: m.entry, ...m.fees, shareBps: m.shareBps, won: result === "won" }).backerNet;
}

export interface ReturnCandidate {
  isOwn: boolean;
  /** Owner Account key of the holding's Source. */
  sourceOwner: string;
  amount: bigint;
  /** Reserved for Backing Offers: not free to return. */
  reserved: bigint;
  /** The Source's Debt in Gemas. */
  sourceDebt: bigint;
}

/**
 * Gemas `account` may hand back to one Source with `return_own`: only its own-Sourced, unspent Gemas,
 * at most that Source's Debt. Won and foreign-Sourced Gemas never count, and reserved Gemas (Offers)
 * or Gemas in a Pot are not free.
 */
export function returnableGemas(h: ReturnCandidate, account: string): bigint {
  if (!h.isOwn || h.sourceOwner !== account) return 0n;
  return min(sat(h.amount, h.reserved), h.sourceDebt);
}
