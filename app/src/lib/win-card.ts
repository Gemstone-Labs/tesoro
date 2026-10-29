import { avatarIndexFor } from "@/lib/art";
import type { ChainMatch } from "@/lib/chain/read";
import { matchDelta } from "@/lib/chain/ledger";
import { shortKey } from "@/lib/chain/history";
import type { ProfileData } from "@/lib/identity/display";
import type { GameId } from "@/lib/mock";
import { GAME_NAMES } from "@/lib/mock";
import { GEMS } from "@/lib/waitlist-spot";
import { BRAND } from "./brand";
import { parseMatchKey } from "./chain/match-id";

/** What the win card shows: one won, settled Match. */
export interface WinCardData {
  id: string;
  game: GameId;
  entry: number;
  /** Gemas the winner gained, net of Fees; 0 when a Backing share leaves the Player nothing. */
  gemas: number;
  /** The winner's Profile name, or their short key when they have none. */
  name: string;
  /** 1-based, like the files in assets/share. */
  avatar: number;
  hex: string;
}

/** A Match key (`<opener>-<n>`) from a URL segment, or null when it is not one. */
export const parseWinKey = parseMatchKey;

/** The winning seat of a settled Match; null for open, active, refunded and drawn ones, or when the result is unread. */
export function winningSeat(m: ChainMatch): 0 | 1 | null {
  if (m.status !== "settled") return null;
  const result = m.session ? (m.session.settled ? m.session.result : null) : m.winner;
  if (result === "opener") return 0;
  if (result === "joiner") return m.sides[1] ? 1 : null;
  return null;
}

/** The card for a Match, or null when it has no winner to show. */
export function winCardData(m: ChainMatch, profile: ProfileData | null): WinCardData | null {
  const seat = winningSeat(m);
  if (seat === null) return null;
  const side = m.sides[seat];
  if (!side) return null;
  const backing = side.funder !== side.player ? { shareBps: side.shareBps } : null;
  const gemas = Math.max(0, matchDelta({ ...m, seat, backing }));
  const pick = profile?.avatar;
  const index = pick?.kind === "animal" && pick.index < GEMS.length ? pick.index : avatarIndexFor(side.player);
  return { id: m.id, game: m.game, entry: m.entry, gemas, name: profile?.name ?? shortKey(side.player), avatar: index + 1, hex: GEMS[index].hex };
}

/** The card of a settled Match with a winner, as the Match history keeps it (`win_card`): the winning Player and what they gained. */
export function winCardFromRow(card: { id: string; game: string; entry: number; winner: string; gemas: number }, profile: ProfileData | null): WinCardData | null {
  if (!GAMES.includes(card.game as GameId)) return null;
  const pick = profile?.avatar;
  const index = pick?.kind === "animal" && pick.index < GEMS.length ? pick.index : avatarIndexFor(card.winner);
  return { id: card.id, game: card.game as GameId, entry: card.entry, gemas: card.gemas, name: profile?.name ?? shortKey(card.winner), avatar: index + 1, hex: GEMS[index].hex };
}

const GAMES: readonly GameId[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];

export const winPath = (id: string) => `/win/${id}`;

export function winShareText(w: Pick<WinCardData, "game" | "gemas" | "entry">): string {
  const won = w.gemas > 0 ? `won ${w.gemas.toLocaleString("en-US")} Gemas` : "won";
  return `I just ${won} in a ${GAME_NAMES[w.game]} Match on ${BRAND.handle}.`;
}

export const postUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
