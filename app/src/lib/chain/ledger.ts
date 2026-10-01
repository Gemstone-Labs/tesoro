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

/** tesoro_core `MAX_ENTRY_SOURCES`: Holdings (Sources) one entry may draw on. */
export const MAX_ENTRY_SOURCES = 8;

export class EntryError extends Error {
  constructor(readonly code: "insufficient" | "too-many-sources") {
    super(
      code === "insufficient"
        ? "Not enough Gemas for this entry"
        : `This entry would draw on more than ${MAX_ENTRY_SOURCES} Sources`,
    );
  }
}

export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Picks the smallest set of Holdings an entry can draw on, in the order tesoro_core requires:
 * own-sourced class first, then won, each ascending by Source. Returns indices into `holdings`.
 *
 * The program takes `min(entry, own free)` from the own class, the rest from won Gemas. Within a
 * class it accepts any strictly ascending subset in which every Holding but the last is drained
 * and the last contributes something. So when the class must be drained completely every Holding
 * with Gemas is needed; otherwise a minimum cover (largest balances first) always satisfies that
 * rule, because dropping the last Holding of a minimum cover would leave it short.
 */
export function planEntry(entry: bigint, holdings: EntryHolding[]): number[] {
  const ownFree = holdings.filter((h) => h.isOwn).reduce((s, h) => s + h.free, 0n);
  const wonFree = holdings.filter((h) => !h.isOwn).reduce((s, h) => s + h.free, 0n);
  const ownNeed = min(entry, ownFree);
  const wonNeed = entry - ownNeed;
  if (wonNeed > wonFree) throw new EntryError("insufficient");
  const picked: number[] = [];
  for (const [isOwn, need, classFree] of [
    [true, ownNeed, ownFree],
    [false, wonNeed, wonFree],
  ] as const) {
    if (need === 0n) continue;
    const candidates = holdings.map((h, i) => [h, i] as const).filter(([h]) => h.isOwn === isOwn && h.free > 0n);
    let chosen = candidates;
    if (need < classFree) {
      const byBalance = [...candidates].sort(([a], [b]) => (a.free === b.free ? compareKeys(a.source, b.source) : a.free > b.free ? -1 : 1));
      chosen = [];
      let left = need;
      for (const c of byBalance) {
        if (left === 0n) break;
        chosen.push(c);
        left -= min(left, c[0].free);
      }
    }
    chosen.sort(([a], [b]) => compareKeys(a.source, b.source));
    picked.push(...chosen.map(([, i]) => i));
  }
  if (picked.length > MAX_ENTRY_SOURCES) throw new EntryError("too-many-sources");
  return picked;
}

/** Why an entry cannot be made from these Holdings, or null when it can. */
export function entryProblem(entry: bigint, holdings: EntryHolding[]): EntryError["code"] | null {
  try {
    planEntry(entry, holdings);
    return null;
  } catch (e) {
    if (e instanceof EntryError) return e.code;
    throw e;
  }
}

/** Fee taken from the Pot at settlement, in Gemas (each share floored, as in the ledger). */
export function feeGemas(entry: bigint, platformBps: number, studioBps: number): bigint {
  const pot = entry * 2n;
  return (pot * BigInt(platformBps)) / 10_000n + (pot * BigInt(studioBps)) / 10_000n;
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
export function backedSplit(a: { entry: number; platformBps: number; studioBps: number; shareBps: number; won: boolean }): BackedSplit {
  if (!a.won) {
    return { fees: 0, surplus: 0, playerShare: 0, backerEntryBack: 0, backerSurplus: 0, backerNet: -a.entry, playerNet: 0 };
  }
  const fees = Number(feeGemas(BigInt(a.entry), a.platformBps, a.studioBps));
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
 * Gemas won or lost at settlement, net of Fees. Refunds and draws are 0. Block Puzzle settles from
 * its Session; Hold'em has none, so a settled table's winner comes in as `winner`. A backed Player
 * (`backing`) only ever gains their share of the surplus and loses nothing.
 */
export function matchDelta(
  m: Outcome & {
    seat: 0 | 1 | null;
    entry: number;
    fees: { platformBps: number; studioBps: number };
    backing?: { shareBps: number } | null;
  },
): number {
  const result = m.seat === null ? null : seatResult(m, m.seat);
  if (result === null || result === "draw") return 0;
  const won = result === "won";
  if (m.backing) return backedSplit({ entry: m.entry, ...m.fees, shareBps: m.backing.shareBps, won }).playerNet;
  if (!won) return -m.entry;
  return m.entry - Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps));
}

/** The Backer's result of a Match they funded: the split on a win, the entry on a loss, 0 on a draw or refund. */
export function backerDelta(
  m: Outcome & { backerSeat: 0 | 1; entry: number; fees: { platformBps: number; studioBps: number }; shareBps: number },
): number {
  const result = seatResult(m, m.backerSeat);
  if (result === null || result === "draw") return 0;
  return backedSplit({ entry: m.entry, ...m.fees, shareBps: m.shareBps, won: result === "won" }).backerNet;
}
