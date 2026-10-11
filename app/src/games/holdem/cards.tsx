"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NO_CARD } from "./chain";
import { useReducedMotion } from "../fx";
import { centre, flyFrom } from "./motion";

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

export type FlipState = "empty" | "down" | "up";

/**
 * A card that turns over in 3D. `down` shows the back, `up` the face (`card` must be known), `empty` a
 * dashed slot. A card that appears with `fly` slides in from the deck and, when it is meant to end face up,
 * turns after it lands. Under reduced motion it is simply in its final state.
 */
export function FlipCard({
  card,
  state,
  size = "md",
  fly,
  turnDelay = 0,
  mark = null,
}: {
  card?: number | null;
  state: FlipState;
  size?: "md" | "lg";
  /** Slide in from this screen point (the deck) when the card first appears; `delay` ms before it leaves. */
  fly?: { deck: React.RefObject<HTMLElement | null>; delay: number } | null;
  /** Extra wait before turning face up after appearing, ms. */
  turnDelay?: number;
  /** At a showdown: part of the winning five (`win`) or not (`dim`). */
  mark?: "win" | "dim" | null;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const present = state !== "empty";
  const wantsUp = state === "up" && card !== null && card !== undefined && card < NO_CARD;
  const flies = !!fly && !reduced;
  const [up, setUp] = useState(wantsUp && !flies);

  useLayoutEffect(() => {
    if (!present || !fly || !ref.current) return;
    const deck = fly.deck.current;
    if (deck) flyFrom(ref.current, centre(deck.getBoundingClientRect()), { delay: fly.delay });
    // Runs when the card appears; `fly` is only set for that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  useEffect(() => {
    if (wantsUp === up) return;
    const wait = !wantsUp || reduced ? 0 : turnDelay;
    const id = setTimeout(() => setUp(wantsUp), wait);
    return () => clearTimeout(id);
  }, [wantsUp, up, reduced, turnDelay]);

  if (!present) return <span className={`hd-card ${size} empty`} aria-hidden="true" />;
  const label = wantsUp && up && card !== null && card !== undefined ? cardText(card) : "Face-down card";
  return (
    <span ref={ref} className={`hd-flipc ${size}${mark ? ` ${mark}` : ""}`} role="img" aria-label={label}>
      <span className={`hd-flipc-in${up ? " up" : ""}`}>
        <PlayingCard back />
        {card !== null && card !== undefined && card < NO_CARD ? <PlayingCard card={card} /> : <span className="hd-card empty" />}
      </span>
    </span>
  );
}
