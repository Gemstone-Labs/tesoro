/**
 * Leaderboard seasons: the constants and standings maths of programs/tesoro_core/src/ledger/season.rs.
 * Pure (no RPC, no Node APIs), so the page, the server route and the keeper share one implementation.
 * A won Match emits `MatchWon`; a season's standings are the sum of those events (docs/adr/0006).
 */

/** Monday 2026-10-05 00:00:00 UTC. Season 1 starts here and every season is one week. */
export const SEASON_EPOCH = 1_791_158_400;
export const SEASON_SECS = 7 * 24 * 60 * 60;
/** Leaderboard Fee in basis points of the Pot. Display default: the program reads the live rate from its Config. */
export const LEADERBOARD_BPS = 100;
/** Ranks that are paid, and each one's share of the pool in basis points (sums to 10,000). */
export const PRIZE_BPS = [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400] as const;
export const PRIZE_PLACES = PRIZE_BPS.length;
/** A won Match earns `entry / POINTS_DIVISOR` points. */
export const POINTS_DIVISOR = 100;

/** Season number (from 1) containing `ts` (unix seconds); 0 before the first season. */
export function seasonAt(ts: number): number {
  return ts < SEASON_EPOCH ? 0 : Math.floor((ts - SEASON_EPOCH) / SEASON_SECS) + 1;
}
export const seasonStart = (n: number) => SEASON_EPOCH + (n - 1) * SEASON_SECS;
/** First second after season `n`. */
export const seasonEnd = (n: number) => SEASON_EPOCH + n * SEASON_SECS;

export const pointsForWin = (entry: number | bigint) => Number(BigInt(entry) / BigInt(POINTS_DIVISOR));

/** What each rank is paid from a pool of `poolTotal` Gemas, floored as in the program. */
export function prizeAmounts(poolTotal: bigint, ranked: number): bigint[] {
  return PRIZE_BPS.map((bps, i) => (i < ranked ? (poolTotal * BigInt(bps)) / 10_000n : 0n));
}

/** One won Match, as emitted by `MatchWon`. */
export interface Win {
  /** TesoroAccount of the Player who played. */
  player: string;
  points: number;
  /** Unix seconds the Match settled. */
  ts: number;
  matchId: string;
}

export interface Standing {
  rank: number;
  account: string;
  points: number;
  wins: number;
  /** Earliest win in the season: the tie-break. */
  firstWinTs: number;
}

/**
 * The season table from its wins. Order: points (most first), then the earlier first win of the
 * season, then the Account key (so the order is total and every reader agrees).
 */
export function standings(wins: Win[]): Standing[] {
  const by = new Map<string, Standing>();
  for (const w of wins) {
    const s = by.get(w.player);
    if (s) {
      s.points += w.points;
      s.wins += 1;
      s.firstWinTs = Math.min(s.firstWinTs, w.ts);
    } else by.set(w.player, { rank: 0, account: w.player, points: w.points, wins: 1, firstWinTs: w.ts });
  }
  const rows = [...by.values()].filter((s) => s.points > 0);
  rows.sort((a, b) => b.points - a.points || a.firstWinTs - b.firstWinTs || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

let since = Infinity;
/** Unix seconds `init_leaderboard` first ran (`Config.leaderboard_since`); Infinity until read, so no fee is shown that was not charged. */
export const setLeaderboardSince = (ts: number) => void (since = ts > 0 ? ts : Infinity);

/**
 * Leaderboard Fee in basis points that a Match opened at `openedAtMs` was charged: none for one opened
 * before the Leaderboard started (it was settled under the old fees).
 */
export const leaderboardBpsFor = (openedAtMs: number): number => (openedAtMs / 1000 >= since ? LEADERBOARD_BPS : 0);
