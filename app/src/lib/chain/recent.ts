import type { SettledMatch, SettledQuery } from "./settled";
import { readScores, topScores } from "./settled";

export type { SettledMatch } from "./settled";

/**
 * Settled Matches with a winner (draws and refunds are skipped), newest first: the Lobby ticker. They come
 * from the Match history (ticket 20) through `/api/recent-wins`, because a settled Match's account is
 * closed. An unavailable history is an empty ticker.
 */
export async function fetchSettled(q: SettledQuery, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<SettledMatch[]> {
  const params = new URLSearchParams({ limit: String(q.limit) });
  if (q.game) params.set("game", q.game);
  if (q.since !== undefined) params.set("since", String(Math.floor(q.since)));
  try {
    const res = await fetcher(`/api/recent-wins?${params}`);
    if (!res.ok) return [];
    return ((await res.json()) as SettledMatch[]).map((m) => ({ ...m, scores: readScores(m.scores) }));
  } catch {
    return [];
  }
}

/** The newest `limit` settled Matches with a winner, any game (the Lobby ticker). */
export const fetchRecentSettled = (limit = 8) => fetchSettled({ limit });

/** Most Block Burst Matches read for one day's top scores. */
export const TOP_SCAN_LIMIT = 150;

/** The best winning Block Burst scores of the last 24 hours. */
export async function fetchTopScoresToday(now = Date.now()): Promise<[string, number][]> {
  return topScores(await fetchSettled({ game: "block-puzzle", since: now - 24 * 60 * 60 * 1000, limit: TOP_SCAN_LIMIT }));
}
