import { avatarIndexFor } from "@/lib/art";
import type { ChainMatch } from "@/lib/chain/read";
import { matchDelta } from "@/lib/chain/ledger";
import { historyGameName, shortKey, type HistoryGame } from "@/lib/chain/history";
import { rideRecordOf, type StoredRide } from "@/lib/chain/ride-history";
import { replayRide } from "@/games/railcar/replay";
import { clock } from "@/games/railcar/words";
import type { ProfileData } from "@/lib/identity/display";
import type { GameId } from "@/lib/mock";
import { GEMS } from "@/lib/waitlist-spot";
import { BRAND } from "./brand";
import { parseMatchKey } from "./chain/match-id";

/** What the win card shows: one won, settled Match. */
export interface WinCardData {
  id: string;
  game: HistoryGame;
  entry: number;
  /** Gemas the winner gained, net of Fees; 0 when a Backing share leaves the Player nothing. */
  gemas: number;
  /** The winner's Profile name, or their short key when they have none. */
  name: string;
  /** 1-based, like the files in assets/share. */
  avatar: number;
  hex: string;
  /** A Railcar ride: how many rode, when the winner (last off) jumped and when the wall came, ride-clock ms. */
  ride?: { seated: number; lastOffMs: number; wallMs: number };
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

/**
 * The card of a settled Match with a winner, as the Match history keeps it (`win_card`): the winning Player and what they
 * gained. A Railcar ride's winner is its last Player off; the ride is replayed for when they jumped and when the wall came.
 */
export function winCardFromRow(card: { id: string; game: string; entry: number; winner: string; gemas: number; ride?: StoredRide | null }, profile: ProfileData | null): WinCardData | null {
  const railcar = card.game === "railcar";
  if (!GAMES.includes(card.game as GameId) && !railcar) return null;
  const rec = railcar ? rideRecordOf({ entry: card.entry, ride: card.ride }) : null;
  if (railcar && !rec) return null;
  const pick = profile?.avatar;
  const index = pick?.kind === "animal" && pick.index < GEMS.length ? pick.index : avatarIndexFor(card.winner);
  const base = { id: card.id, game: card.game as HistoryGame, entry: card.entry, gemas: card.gemas, name: profile?.name ?? shortKey(card.winner), avatar: index + 1, hex: GEMS[index].hex };
  if (!rec) return base;
  const r = replayRide(rec);
  const first = r.seats.find((s) => s.place === 1);
  return { ...base, ride: { seated: rec.seats.length, lastOffMs: first?.jumpMs ?? 0, wallMs: r.impactMs ?? 0 } };
}

const GAMES: readonly GameId[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];

export const winPath = (id: string) => `/win/${id}`;

export function winShareText(w: Pick<WinCardData, "game" | "gemas" | "entry" | "ride">): string {
  const won = w.gemas > 0 ? `won ${w.gemas.toLocaleString("en-US")} Gemas` : "won";
  if (w.ride) return `I was last off a Railcar ride and ${won} on ${BRAND.handle}. The wall was at ${clock(w.ride.wallMs)}.`;
  return `I just ${won} in a ${historyGameName(w.game)} Match on ${BRAND.handle}.`;
}

export const postUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
