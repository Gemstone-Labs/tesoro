/**
 * Seven-card Hold'em evaluator, a port of programs/holdem/src/eval.rs. Cards are `0..52` with
 * `rank = card % 13` (0 = deuce, 12 = ace) and `suit = card / 13`. Higher score wins, equal ties.
 * Layout: category in bits 20.., then five 4-bit ranks, most significant first.
 */
export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const TRIPS = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const QUADS = 7;
export const STRAIGHT_FLUSH = 8;

export const category = (score: number) => score >>> 20;

function pack(cat: number, ranks: number[]): number {
  let score = cat << 20;
  for (let i = 0; i < 5; i++) score |= (ranks[i] ?? 0) << (16 - 4 * i);
  return score;
}

/** Highest rank of a straight in a 13-bit rank mask (the wheel is a 5-high straight). */
function straightHigh(mask: number): number | null {
  for (let high = 12; high >= 4; high--) {
    const window = 0b11111 << (high - 4);
    if ((mask & window) === window) return high;
  }
  const WHEEL = (1 << 12) | 0b1111;
  return (mask & WHEEL) === WHEEL ? 3 : null;
}

/** Up to `n` ranks set in `mask`, highest first, skipping `exclude`. */
function topRanks(mask: number, exclude: number[], n: number): number[] {
  const out: number[] = [];
  for (let rank = 12; rank >= 0 && out.length < n; rank--) {
    if (mask & (1 << rank) && !exclude.includes(rank)) out.push(rank);
  }
  return out;
}

/** Scores the best five-card hand from seven distinct cards below 52. */
export function eval7(cards: readonly number[]): number {
  const counts = new Array<number>(13).fill(0);
  const suitMasks = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  let all = 0;
  for (const card of cards) {
    const rank = card % 13;
    const suit = Math.floor(card / 13) % 4;
    counts[rank]++;
    suitMasks[suit] |= 1 << rank;
    suitCounts[suit]++;
    all |= 1 << rank;
  }
  const flushSuit = suitCounts.findIndex((c) => c >= 5);
  if (flushSuit >= 0) {
    const high = straightHigh(suitMasks[flushSuit]);
    if (high !== null) return pack(STRAIGHT_FLUSH, [high]);
  }
  let quad: number | null = null;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let rank = 12; rank >= 0; rank--) {
    const c = counts[rank];
    if (c === 4) quad = rank;
    else if (c === 3 && trips.length < 2) trips.push(rank);
    else if (c === 2 && pairs.length < 3) pairs.push(rank);
  }
  if (quad !== null) return pack(QUADS, [quad, ...topRanks(all, [quad], 1)]);
  if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
    // A second set of trips can supply the pair of the full house.
    const pairRank = trips.length >= 2 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0];
    return pack(FULL_HOUSE, [trips[0], pairRank]);
  }
  if (flushSuit >= 0) return pack(FLUSH, topRanks(suitMasks[flushSuit], [], 5));
  const high = straightHigh(all);
  if (high !== null) return pack(STRAIGHT, [high]);
  if (trips.length === 1) return pack(TRIPS, [trips[0], ...topRanks(all, [trips[0]], 2)]);
  if (pairs.length >= 2) return pack(TWO_PAIR, [pairs[0], pairs[1], ...topRanks(all, [pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return pack(PAIR, [pairs[0], ...topRanks(all, [pairs[0]], 3)]);
  return pack(HIGH_CARD, topRanks(all, [], 5));
}
