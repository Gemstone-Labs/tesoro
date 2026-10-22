import type { GameId } from "../mock/types";
import { matchOpenedAt } from "./match-id";

/** A settled Match anyone may see: the Lobby ticker. Winners are shown by short key (no names on chain). */
export interface SettledMatch {
  id: bigint;
  game: GameId;
  entry: number;
  /** TesoroAccount key of the winning Player. */
  winner: string;
  /** Gemas the winning side received: the Pot minus Fees. */
  payout: number;
  /** Block Burst only: [winner score, loser score]. */
  scores: [number, number] | null;
  /** Milliseconds since the epoch (Match ids embed their creation time). */
  at: number;
}

/** A Match row reduced to what picking settled candidates needs. */
export interface SettledCandidate {
  id: bigint;
  game: GameId | null;
  settled: boolean;
  /** Someone joined: an unjoined Match has no winner. */
  joined: boolean;
}

export interface SettledQuery {
  game?: GameId;
  /** Only Matches created at or after this time (ms since the epoch). */
  since?: number;
  limit: number;
}

/**
 * The settled, joined Matches of `q.game` created since `q.since`, newest first, cut to `limit`. The
 * game and time filters run before the cut, so another game's newer Matches never push these out.
 */
export function pickSettled<T extends SettledCandidate>(rows: T[], q: SettledQuery): T[] {
  return rows
    .filter((m) => m.settled && m.joined && m.game !== null && (!q.game || m.game === q.game) && (q.since === undefined || matchOpenedAt(m.id, m.game) >= q.since))
    .sort((x, y) => (x.id < y.id ? 1 : -1))
    .slice(0, q.limit);
}

/** Best winning score per Player, highest first. */
export function topScores(settled: SettledMatch[], n = 3): [string, number][] {
  const best = new Map<string, number>();
  for (const m of settled) if (m.scores) best.set(m.winner, Math.max(best.get(m.winner) ?? 0, m.scores[0]));
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
