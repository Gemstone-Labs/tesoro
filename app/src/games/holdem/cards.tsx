import { NO_CARD } from "./chain";

const RANK_LABEL = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_NAME = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];
/** Same order as `cardName` in chain.ts: clubs, diamonds, hearts, spades. */
const SUIT_GLYPH = ["♣", "♦", "♥", "♠"];
const SUIT_NAME = ["clubs", "diamonds", "hearts", "spades"];

export const cardText = (card: number) => `${RANK_NAME[card % 13]} of ${SUIT_NAME[Math.floor(card / 13)]}`;

/**
 * One playing card: face up (`card` 0..51), face down (`back`) or an empty slot. The cards are the
 * game art: paper face, red and black suits. Chips and cards never use the emerald.
 */
export function PlayingCard({ card, back, size = "md" }: { card?: number | null; back?: boolean; size?: "md" | "lg" }) {
  const cls = `hd-card ${size}`;
  if (back) return <span className={`${cls} back`} role="img" aria-label="Face-down card" />;
  if (card === null || card === undefined || card >= NO_CARD || card < 0 || card > 51) {
    return <span className={`${cls} empty`} aria-hidden="true" />;
  }
  const suit = Math.floor(card / 13);
  const red = suit === 1 || suit === 2;
  return (
    <span className={`${cls} face${red ? " red" : ""}`} role="img" aria-label={cardText(card)}>
      <span className="hd-rank">{RANK_LABEL[card % 13]}</span>
      <span className="hd-suit">{SUIT_GLYPH[suit]}</span>
    </span>
  );
}
