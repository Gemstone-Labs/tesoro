import type { GameId, MatchResult } from "../mock/types";
import type { HistoryRow } from "./history";
import type { QueueSeat } from "./read";
import { canJoinSeat } from "./queue";
import { canRematch, rematchHref } from "../rematch";
import { gameQuery } from "../game-params";

/** The Player's own settled Matches that can be replayed: no Backer rows, no refunds, one per Game + asset + entry, newest first. */
export function playAgainRows(rows: HistoryRow[], limit = 3): HistoryRow[] {
  const seen = new Set<string>();
  const out: HistoryRow[] = [];
  for (const r of [...rows].sort((a, b) => b.at - a.at)) {
    if (r.role !== "player" || r.result === "refunded") continue;
    const key = `${r.game}|${r.asset ?? 0}|${r.entry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Where Play again leads: a Challenge to the same opponent when that is known, otherwise the Queue at the same entry. */
export function playAgainTarget(r: HistoryRow): { href: string; sameOpponent: boolean } {
  if (canRematch({ role: r.role, outcome: r.result as "won" | "lost" | "draw", opponent: r.opp })) {
    return { href: rematchHref({ game: r.game, asset: r.asset, entry: r.entry, opponent: r.opp! }), sameOpponent: true };
  }
  return { href: `/play/queue?${gameQuery(r.game, r.asset)}entry=${r.entry}`, sameOpponent: false };
}

export interface GameFacts {
  /** Result of the Player's latest decided Match of the Game. */
  last: MatchResult;
  /** Block Burst only: the highest score the Player reached in a finished Match. */
  best: number | null;
}

/** Per Game, the Player's last result and best Block Burst score; Games never played are absent. */
export function gameFacts(rows: HistoryRow[]): Partial<Record<GameId, GameFacts>> {
  const out: Partial<Record<GameId, GameFacts>> = {};
  for (const r of [...rows].sort((a, b) => b.at - a.at)) {
    if (r.role !== "player" || r.result === "refunded") continue;
    const f = (out[r.game] ??= { last: r.result, best: null });
    if (r.game === "block-puzzle" && r.scores) f.best = Math.max(f.best ?? 0, r.scores[0]);
  }
  return out;
}

/** Whether `me` (paying their own entry) may take this seat: not their own, and not a Player they back. */
const takeable = (s: QueueSeat, me?: string) => (me ? canJoinSeat(s, { player: me, funder: me }) : true);

/** Players waiting at each entry of a Game's Queue that `me` could play: not `me`, not a Player `me` backs. */
export function waitingByEntry(seats: QueueSeat[] | undefined, entries: readonly number[], me?: string): Record<number, number> {
  const out: Record<number, number> = Object.fromEntries(entries.map((e) => [e, 0]));
  for (const s of seats ?? []) if (takeable(s, me) && s.entry in out) out[s.entry] += 1;
  return out;
}

/** At one entry: the Players `me` could be paired with (oldest first, once each), and how many waiting Players `me` backs. */
export function seatsAt(seats: QueueSeat[] | undefined, entry: number, me?: string): { open: string[]; backed: number } {
  const here = (seats ?? []).filter((s) => s.entry === entry && s.player !== me);
  return { open: [...new Set(here.filter((s) => takeable(s, me)).map((s) => s.player))], backed: here.filter((s) => !takeable(s, me)).length };
}
