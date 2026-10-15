import type { GameId } from "@/lib/mock/types";
import { DemoHttpError } from "../request-auth";
import type { NotifyEvent } from "./decide";

const GAME_IDS: string[] = ["block-puzzle", "holdem", "trading-duel"];
const KINDS = ["opponent-played", "match-delayed", "match-refunded", "offer-made", "offer-accepted", "debt-cleared", "season-placed"];
const MAX_EVENTS = 100;

const bad = () => new DemoHttpError(400, "bad-request", "Malformed event.");
const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : (() => { throw bad(); })());
const num = (v: unknown, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : (() => { throw bad(); })());
const game = (v: unknown) => (typeof v === "string" && GAME_IDS.includes(v) ? (v as GameId) : (() => { throw bad(); })());

/**
 * The keeper's facts, as the server's events. The server builds each id from the fact itself (never taken
 * from the caller), so the same fact is the same event however many times and by whoever it is sent.
 */
export function parseEvents(raw: unknown): NotifyEvent[] {
  const list = (raw as { events?: unknown } | null)?.events;
  if (!Array.isArray(list) || list.length > MAX_EVENTS) throw bad();
  return list.map((x): NotifyEvent => {
    const b = x as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || typeof b.kind !== "string" || !KINDS.includes(b.kind)) throw bad();
    const authority = str(b.authority, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const key = /^[A-Za-z0-9]{1,64}$/;
    switch (b.kind) {
      case "opponent-played": {
        const matchId = str(b.matchId, /^\d{1,20}$/);
        return { kind: "opponent-played", id: `opponent-played:${matchId}:${authority}`, authority, matchId, game: game(b.game) };
      }
      case "match-delayed": {
        const matchId = str(b.matchId, /^\d{1,20}$/);
        return { kind: "match-delayed", id: `match-delayed:${matchId}:${authority}`, authority, matchId, game: game(b.game), refundBy: num(b.refundBy), refundOpen: b.refundOpen === true };
      }
      case "match-refunded": {
        const matchId = str(b.matchId, /^\d{1,20}$/);
        return { kind: "match-refunded", id: `match-refunded:${matchId}:${authority}`, authority, matchId, game: game(b.game), entry: num(b.entry) };
      }
      case "offer-made": {
        const offerId = str(b.offerId, key);
        return { kind: "offer-made", id: `offer-made:${offerId}:${authority}`, authority, offerId, game: game(b.game), entry: num(b.entry) };
      }
      case "offer-accepted": {
        const offerId = str(b.offerId, key);
        return { kind: "offer-accepted", id: `offer-accepted:${offerId}:${authority}`, authority, offerId, game: game(b.game), entry: num(b.entry) };
      }
      case "debt-cleared": {
        const positionId = str(b.positionId, key);
        const advance = num(b.advance);
        return { kind: "debt-cleared", id: `debt-cleared:${positionId}:${advance}`, authority, positionId, asset: str(b.asset, /^[A-Z]{2,6}$/) };
      }
      default: {
        const season = num(b.season, 1);
        return { kind: "season-placed", id: `season-placed:${season}:${authority}`, authority, season, rank: num(b.rank, 1), gemas: num(b.gemas) };
      }
    }
  });
}
