import type { GameId } from "@/lib/mock/types";
import { BRAND } from "../../lib/brand";

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

interface Base {
  id: string;
  authority: string;
}
/** Block Puzzle: you played first and your opponent has now played too. */
export interface OpponentPlayedEvent extends Base {
  kind: "opponent-played";
  matchId: string;
  game: GameId;
}
/** An Active Match that should have settled by now (the Delayed rule in lib/chain/match-status). */
export interface MatchDelayedEvent extends Base {
  kind: "match-delayed";
  matchId: string;
  game: GameId;
  /** Unix seconds: the Match's refund deadline. */
  refundBy: number;
  refundOpen: boolean;
}
export interface MatchRefundedEvent extends Base {
  kind: "match-refunded";
  matchId: string;
  game: GameId;
  entry: number;
}
/** A Backer made an Offer on this Player's Request. */
export interface OfferMadeEvent extends Base {
  kind: "offer-made";
  offerId: string;
  game: GameId;
  entry: number;
}
/** A Player accepted this Backer's Offer. */
export interface OfferAcceptedEvent extends Base {
  kind: "offer-accepted";
  offerId: string;
  game: GameId;
  entry: number;
}
export interface DebtClearedEvent extends Base {
  kind: "debt-cleared";
  positionId: string;
  asset: string;
}
export interface SeasonPlacedEvent extends Base {
  kind: "season-placed";
  season: number;
  /** 1 is first. */
  rank: number;
  gemas: number;
}

export type NotifyEvent =
  | MatchSettledEvent
  | OpponentPlayedEvent
  | MatchDelayedEvent
  | MatchRefundedEvent
  | OfferMadeEvent
  | OfferAcceptedEvent
  | DebtClearedEvent
  | SeasonPlacedEvent;

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

const GAMES: Record<GameId, string> = { "block-puzzle": "Block Puzzle", holdem: "Hold'em", "trading-duel": "Trading Duel", vanguard: "Vanguard" };
const gemas = (n: number) => `${n.toLocaleString("en-US")} Gemas`;

const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
/** "Thu, Oct 15, 6:09 pm UTC": emails have no time zone of their own to use. */
const utc = (secs: number) => {
  const d = new Date(secs * 1000);
  const h = d.getUTCHours();
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${date}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"} UTC`;
};

/** The plain words for one event. */
export function describe(e: NotifyEvent): Message {
  const game = "game" in e ? (GAMES[e.game] ?? "Match") : "Match";
  switch (e.kind) {
    case "match-settled":
      if (e.result === "won") return { subject: `You won your ${game} Match`, body: `You won your ${game} Match and ${gemas(e.gemas)}. The Pot was ${gemas(e.pot)}.` };
      if (e.result === "lost") return { subject: `You lost your ${game} Match`, body: `You lost your ${game} Match and ${gemas(e.gemas)}. The Pot was ${gemas(e.pot)}.` };
      return { subject: `Your ${game} Match was a draw`, body: `Your ${game} Match was a draw. Your entry came back and nothing was won or lost.` };
    case "opponent-played":
      return { subject: `Your opponent has played your ${game} Match`, body: `Your opponent has played your ${game} Match. It is being settled now, and you will get another email with the result.` };
    case "match-delayed":
      return {
        subject: `Your ${game} Match is delayed`,
        body: `Your ${game} Match is taking longer than expected to settle. Your Gemas are safe. ${
          e.refundOpen ? "Its refund is open now, so your entry can come back at any time." : `If it does not settle, it is refunded by ${utc(e.refundBy)}.`
        }`,
      };
    case "match-refunded":
      return { subject: `Your ${game} Match was refunded`, body: `Your ${game} Match was refunded. Your entry of ${gemas(e.entry)} is back in your Account.` };
    case "offer-made":
      return { subject: "A Backer made you an Offer", body: `A Backer made an Offer on your ${game} Request for an entry of ${gemas(e.entry)}. Open Backing to accept it.` };
    case "offer-accepted":
      return { subject: "A Player accepted your Offer", body: `A Player accepted your ${game} Offer for an entry of ${gemas(e.entry)}. Your Gemas stay reserved until their Match starts.` };
    case "debt-cleared":
      return { subject: "Your Debt is paid off", body: `The Debt on your ${e.asset} Position reached 0. You can Unlock your Position or take another Advance.` };
    case "season-placed":
      return { subject: `You placed ${ordinal(e.rank)} in Season ${e.season}`, body: `You placed ${ordinal(e.rank)} in Season ${e.season} and won ${gemas(e.gemas)} from the Pool. They are in your Account.` };
  }
}

export const footer = (siteUrl: string) => `\n\nSee it in ${BRAND.name}: ${siteUrl}\nTurn these emails off any time in Edit profile.`;

/**
 * Who gets what for one event. Only a verified address with notifications on gets mail. Up to
 * `DAILY_LIMIT` emails a day go out at once; after that an event is held for the digest.
 */
export function decide(event: NotifyEvent, prefs: NotifyPrefs | null, sentToday: number, siteUrl = `https://www.${BRAND.domain}`): Decision {
  if (!prefs) return { emails: [], digest: [], skipped: "no-address" };
  if (!prefs.verified) return { emails: [], digest: [], skipped: "unverified" };
  if (!prefs.enabled) return { emails: [], digest: [], skipped: "off" };
  const m = describe(event);
  if (sentToday >= DAILY_LIMIT) return { emails: [], digest: [m] };
  return { emails: [{ to: prefs.email, subject: m.subject, text: m.body + footer(siteUrl) }], digest: [] };
}
