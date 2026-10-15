import type { GameId } from "@/lib/mock/types";

/** Past this many emails in one day, further events wait for the daily digest. */
export const DAILY_LIMIT = 5;

/**
 * Domain events a Player can be told about. Each carries a unique `id` (the same fact always has the
 * same id, so it is sent once) and the `authority` it is for. Add a variant here, a case in `describe`.
 */
export interface MatchSettledEvent {
  kind: "match-settled";
  id: string;
  authority: string;
  matchId: string;
  game: GameId;
  result: "won" | "lost" | "draw";
  /** Gemas won or lost, after Fees; 0 on a draw. */
  gemas: number;
  /** Both entries together. */
  pot: number;
}

export type NotifyEvent = MatchSettledEvent;

export interface NotifyPrefs {
  email: string;
  verified: boolean;
  enabled: boolean;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** What one event says, before it is addressed. Also the line it takes in a digest. */
export interface Message {
  subject: string;
  body: string;
}

export interface Decision {
  /** Emails to send now. */
  emails: Email[];
  /** Messages to hold for the Player's daily digest. */
  digest: Message[];
  skipped?: "no-address" | "unverified" | "off";
}

const GAMES: Record<GameId, string> = { "block-puzzle": "Block Puzzle", holdem: "Hold'em", "trading-duel": "Trading Duel" } as Record<GameId, string>;
const gemas = (n: number) => `${n.toLocaleString("en-US")} Gemas`;

/** The plain words for one event. */
export function describe(e: NotifyEvent): Message {
  const game = GAMES[e.game] ?? "Match";
  switch (e.kind) {
    case "match-settled":
      if (e.result === "won") return { subject: `You won your ${game} Match`, body: `You won your ${game} Match and ${gemas(e.gemas)}. The Pot was ${gemas(e.pot)}.` };
      if (e.result === "lost") return { subject: `You lost your ${game} Match`, body: `You lost your ${game} Match and ${gemas(e.gemas)}. The Pot was ${gemas(e.pot)}.` };
      return { subject: `Your ${game} Match was a draw`, body: `Your ${game} Match was a draw. Your entry came back and nothing was won or lost.` };
  }
}

export const footer = (siteUrl: string) => `\n\nSee it in Tesoro: ${siteUrl}\nTurn these emails off any time in Edit profile.`;

/**
 * Who gets what for one event. Only a verified address with notifications on gets mail. Up to
 * `DAILY_LIMIT` emails a day go out at once; after that an event is held for the digest.
 */
export function decide(event: NotifyEvent, prefs: NotifyPrefs | null, sentToday: number, siteUrl = "https://www.playtesoro.com"): Decision {
  if (!prefs) return { emails: [], digest: [], skipped: "no-address" };
  if (!prefs.verified) return { emails: [], digest: [], skipped: "unverified" };
  if (!prefs.enabled) return { emails: [], digest: [], skipped: "off" };
  const m = describe(event);
  if (sentToday >= DAILY_LIMIT) return { emails: [], digest: [m] };
  return { emails: [{ to: prefs.email, subject: m.subject, text: m.body + footer(siteUrl) }], digest: [] };
}
