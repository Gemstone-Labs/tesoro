/** Rows per page of the Season table, under the podium: with the podium, ten Players a page (founder, Oct 29). */
export const PAGE_SIZE = 7;
/** The podium's places: always shown, never part of a page. */
export const PODIUM = 3;

/** Pages the ranks below the podium fill (at least 1). */
export const pageCount = (ranked: number): number => Math.max(1, Math.ceil(Math.max(0, ranked - PODIUM) / PAGE_SIZE));

/** The 0-based page a `?page=` value names (1-based in the URL), kept inside the pages that exist; anything unreadable is the first. */
export function pageFromParam(param: string | null, pages: number): number {
  const n = Number(param);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, pages) - 1 : 0;
}

/** The `?page=` value for a 0-based page: none for the first. */
export const paramForPage = (page: number): string | null => (page <= 0 ? null : String(page + 1));

/** The 0-based page a rank below the podium sits on; null for the podium. */
export const pageOfRank = (rank: number): number | null => (rank > PODIUM ? Math.floor((rank - PODIUM - 1) / PAGE_SIZE) : null);

/** The rows of one page of `rows` (the whole standings, best first): ranks 4–10 on page 0, 11–17 on page 1, … */
export const pageRows = <T,>(rows: readonly T[], page: number): T[] => rows.slice(PODIUM + page * PAGE_SIZE, PODIUM + (page + 1) * PAGE_SIZE);

/** The first and last rank a page shows. */
export function rankRange(page: number, ranked: number): { from: number; to: number } {
  return { from: PODIUM + 1 + page * PAGE_SIZE, to: Math.min(ranked, PODIUM + (page + 1) * PAGE_SIZE) };
}

/** Page buttons to draw (0-based pages, `null` = a gap): the first, the last and the neighbours of the current page. */
export function pageItems(page: number, pages: number): (number | null)[] {
  const keep = new Set([0, pages - 1, page - 1, page, page + 1]);
  const out: (number | null)[] = [];
  for (let i = 0; i < pages; i++) {
    if (keep.has(i)) out.push(i);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}
