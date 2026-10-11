import { NO_CARD } from "./chain";
import { FLUSH, FULL_HOUSE, HIGH_CARD, PAIR, QUADS, STRAIGHT, STRAIGHT_FLUSH, TRIPS, TWO_PAIR, category, eval7 } from "./practice/eval";

export interface BestHand {
  /** Plain-word name: "Pair of Kings", "Flush, Ace high". */
  name: string;
  /** Just the kind of hand: "Pair", "Flush". */
  kind: string;
  category: number;
  /** The cards that make the hand (at most five). */
  cards: number[];
  score: number;
}

const RANK = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
const PLURAL = ["Twos", "Threes", "Fours", "Fives", "Sixes", "Sevens", "Eights", "Nines", "Tens", "Jacks", "Queens", "Kings", "Aces"];
const KIND = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];
const rankOf = (c: number) => c % 13;

function nameOf(cat: number, r: number[]): string {
  switch (cat) {
    case PAIR:
      return `Pair of ${PLURAL[r[0]]}`;
    case TWO_PAIR:
      return `Two pair, ${PLURAL[r[0]]} and ${PLURAL[r[1]]}`;
    case TRIPS:
      return `Three of a kind, ${PLURAL[r[0]]}`;
    case STRAIGHT:
      return `Straight, ${RANK[r[0]]} high`;
    case FLUSH:
      return `Flush, ${RANK[r[0]]} high`;
    case FULL_HOUSE:
      return `Full house, ${PLURAL[r[0]]} over ${PLURAL[r[1]]}`;
    case QUADS:
      return `Four of a kind, ${PLURAL[r[0]]}`;
    case STRAIGHT_FLUSH:
      return r[0] === 12 ? "Royal flush" : `Straight flush, ${RANK[r[0]]} high`;
    default:
      return `${RANK[r[0]]} high`;
  }
}

const ranksOfScore = (score: number) => [0, 1, 2, 3, 4].map((i) => (score >>> (16 - 4 * i)) & 15);

function combos<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...combos(rest, k - 1).map((c) => [head, ...c]), ...combos(rest, k)];
}

/** Fewer than five cards: only groups of equal ranks, or the highest card, can be named. */
function small(cards: number[]): BestHand {
  const byRank = new Map<number, number[]>();
  for (const c of cards) byRank.set(rankOf(c), [...(byRank.get(rankOf(c)) ?? []), c]);
  const groups = [...byRank.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
  const [first, second] = groups;
  let cat = HIGH_CARD;
  let ranks = [first[0]];
  let used = first[1].slice(0, 1);
  if (first[1].length === 4) [cat, ranks, used] = [QUADS, [first[0]], first[1]];
  else if (first[1].length === 3) [cat, ranks, used] = [TRIPS, [first[0]], first[1]];
  else if (first[1].length === 2 && second?.[1].length === 2) [cat, ranks, used] = [TWO_PAIR, [first[0], second[0]], [...first[1], ...second[1]]];
  else if (first[1].length === 2) [cat, ranks, used] = [PAIR, [first[0]], first[1]];
  else {
    const top = [...byRank.keys()].sort((a, b) => b - a)[0];
    ranks = [top];
    used = byRank.get(top)!.slice(0, 1);
  }
  const score = (cat << 20) | ranks.reduce((s, r, i) => s | (r << (16 - 4 * i)), 0);
  return { name: nameOf(cat, ranks), kind: KIND[cat], category: cat, cards: used, score };
}

/** The best hand `hole` and `board` make. Cards not yet dealt (255) are ignored. */
export function bestHand(hole: readonly number[], board: readonly number[]): BestHand {
  const known = [...new Set([...hole, ...board].filter((c) => c < NO_CARD && c >= 0))];
  if (known.length < 5) return small(known);
  let best: { score: number; cards: number[] } | null = null;
  for (const five of combos(known, 5)) {
    const score = eval7(five);
    if (!best || score > best.score) best = { score, cards: five };
  }
  const { score, cards } = best!;
  const cat = category(score);
  return { name: nameOf(cat, ranksOfScore(score)), kind: KIND[cat], category: cat, cards, score };
}

/** Which hand wins (1 = a, -1 = b, 0 = tie) and why, in plain words. */
export function compareHands(a: BestHand, b: BestHand): { result: 1 | -1 | 0; text: string } {
  if (a.score === b.score) return { result: 0, text: `Both have ${a.name}` };
  const [w, l, result] = a.score > b.score ? [a, b, 1 as const] : [b, a, -1 as const];
  if (w.category !== l.category) return { result, text: `${w.kind} beats ${l.kind}` };
  if (w.name === l.name) return { result, text: `${w.name} wins on the kicker` };
  return { result, text: `${w.name} beats ${l.name}` };
}
