import type { GameId } from "../mock/types";

/** A settled Match anyone may see: the Lobby ticker. Winners are shown by short key (no names on chain). */
export interface SettledMatch {
  /** The Match key, `<opener>-<n>`. */
  id: string;
  game: GameId;
  entry: number;
  /** TesoroAccount key of the winning Player. */
  winner: string;
  /** Gemas the winning side received: the Pot minus Fees. */
  payout: number;
  /** Block Burst only: [winner score, loser score]. */
  scores: [number, number] | null;
  /** Milliseconds since the epoch the Match opened. */
  at: number;
}

export interface SettledQuery {
  game?: GameId;
  /** Only Matches opened at or after this time (ms since the epoch). */
  since?: number;
  limit: number;
}

/** Best winning score per Player, highest first. */
export function topScores(settled: SettledMatch[], n = 3): [string, number][] {
  const best = new Map<string, number>();
  for (const m of settled) if (m.scores) best.set(m.winner, Math.max(best.get(m.winner) ?? 0, m.scores[0]));
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
