/** The wall's clips (public/art/waitlist, made by scripts/import-waitlist-clips.mjs), by number. */
export const CLIP_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** Clips that look alike and so never sit next to each other (none yet: every clip is its own game). */
export const SIMILAR: [number, number][] = [];
export const CLIP_SIZE = { width: 400, height: 400 };
/** Start on load; the rest wait for an idle moment. */
export const FIRST_CLIPS = 4;
export const WALL_COLUMNS = 7;
export const WALL_ROWS = 8;

/** Most clips playing at once; tiles past the cap show their poster. */
export const MAX_PLAYING = { wide: 10, phone: 6 };

const clash = (a: number, b: number) => a === b || SIMILAR.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * One list of clips per column. Within a column the list loops, and each tile differs from the ones above
 * and below it and from the left neighbour's tiles in rows r-1..r+1 (the columns are staggered), so no two
 * identical or similar clips ever sit side by side. Deterministic.
 */
export function buildColumns(ids: number[] = CLIP_IDS, columns = WALL_COLUMNS, rows = WALL_ROWS): number[][] {
  const grid: number[][] = [];
  const fits = (col: number[], c: number, r: number, id: number) => {
    const vertical = [1, 2].every((d) => (r - d < 0 || !clash(col[r - d], id)) && (r + d < rows || !clash(col[r + d - rows], id)));
    if (!vertical) return false;
    const left = grid[c - 1];
    return !left || [-1, 0, 1].every((d) => !clash(left[(r + d + rows) % rows], id));
  };
  const fill = (col: number[], c: number, r: number): boolean => {
    if (r === rows) return true;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[(c * 5 + r * 3 + k) % ids.length];
      if (!fits(col, c, r, id)) continue;
      col[r] = id;
      if (fill(col, c, r + 1)) return true;
    }
    return false;
  };
  for (let c = 0; c < columns; c++) {
    const col: number[] = [];
    if (!fill(col, c, 0)) throw new Error("No wall layout satisfies the neighbour rule");
    grid.push(col);
  }
  return grid;
}

export const WALL = buildColumns();
