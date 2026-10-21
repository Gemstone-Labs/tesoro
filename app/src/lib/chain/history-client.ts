import type { HistoryRow } from "./history";

export interface HistoryPageData {
  rows: HistoryRow[];
  page: number;
  pages: number;
  total: number;
}

/**
 * One page of an Account's finished Matches from the history route. Null when the history is not available
 * (the database is not configured, as on a dev machine, or the route failed): the page then shows only the
 * Account's live Matches, which come from the chain.
 */
export async function fetchHistoryPage(account: string, page = 1, game: string | null = null, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<HistoryPageData | null> {
  try {
    const q = new URLSearchParams({ page: String(page) });
    if (game) q.set("game", game);
    const res = await fetcher(`/api/history/${account}?${q}`);
    if (!res.ok) return null;
    return (await res.json()) as HistoryPageData;
  } catch {
    return null;
  }
}

/** Up to 2,000 of an Account's newest finished Matches in one read, for its totals and chart; null when the history is not available. */
export async function fetchAllHistory(account: string, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<HistoryRow[] | null> {
  try {
    const res = await fetcher(`/api/history/${account}?all=1`);
    if (!res.ok) return null;
    return ((await res.json()) as HistoryPageData).rows;
  } catch {
    return null;
  }
}
