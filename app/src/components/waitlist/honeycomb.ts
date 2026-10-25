import { CLIP_IDS } from "./clips";

export type Rect = { left: number; top: number; right: number; bottom: number };
export const DRIFT_SPEED = 28; // CSS pixels per second along the diagonal, at every viewport size.
export const HIGHLIGHT_MS = 3000;

/** An even number of flat-top columns makes both copies meet at the same stagger. */
export function buildHoneycomb(viewWidth: number, viewHeight: number) {
  const width = viewWidth <= 640 ? 120 : Math.min(300, Math.max(220, viewWidth / 5));
  const height = width * Math.sqrt(3) / 2;
  const columnStep = width * 0.75 + 6;
  const rowStep = height + 8;
  const columns = Math.ceil((Math.ceil(viewWidth / columnStep) + 2) / 2) * 2;
  const period = columns * columnStep;
  // Whole-row rise keeps the stagger aligned where diagonal copies join.
  const riseRows = Math.max(1, Math.round(period * 0.45 / rowStep));
  const rise = riseRows * rowStep;
  const duration = Math.hypot(period, rise) / DRIFT_SPEED;
  const rows = Math.ceil(viewHeight / rowStep) + 2 * riseRows + 3;
  const tiles: { id: string; column: number; row: number; clip: number; x: number; y: number }[] = [];
  const grid: number[][] = [];

  for (let column = 0; column < columns; column++) {
    grid[column] = [];
    for (let row = 0; row < rows; row++) {
      const used = new Set([
        grid[column][row - 1],
        grid[column - 1]?.[row],
        grid[column - 1]?.[row + (column % 2 ? 1 : -1)],
        ...(column === columns - 1 ? [grid[0][row + riseRows], grid[0][row + riseRows + 1]] : []),
      ]);
      const clip = Array.from({ length: CLIP_IDS.length }, (_, n) => CLIP_IDS[(column * 3 + row * 5 + n) % CLIP_IDS.length])
        .find((id) => !used.has(id))!;
      grid[column][row] = clip;
      tiles.push({ id: `${column}-${row}`, column, row, clip, x: column * columnStep,
        y: row * rowStep + (column % 2 ? rowStep / 2 : 0) - height / 2 - rise - rowStep });
    }
  }
  const loopTiles = [
    ...tiles.filter((tile) => tile.column === columns - 1).map((tile) => ({ ...tile, id: `lead-${tile.id}`, x: -columnStep, y: tile.y + rise })),
    ...[0, 1].flatMap((copy) => tiles.map((tile) => ({ ...tile, id: `${copy}-${tile.id}`, x: tile.x + copy * period, y: tile.y - copy * rise }))),
  ];
  return { width, height, columns, rows, columnStep, rowStep, period, rise, riseRows, duration, tiles, loopTiles };
}

export function chooseHighlight(ids: string[], previous: string | null, random = Math.random): string | null {
  const choices = ids.filter((id) => id !== previous);
  const pool = choices.length ? choices : ids;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}

/** A lifted tile needs breathing room at the edges and must never light up behind the signup. */
export function isHighlightCandidate(tile: Rect, viewport: Rect, protectedAreas: Rect[]) {
  const margin = 12;
  return tile.left >= viewport.left + margin && tile.right <= viewport.right - margin &&
    tile.top >= viewport.top + 80 && tile.bottom <= viewport.bottom - margin &&
    protectedAreas.every((area) => tile.right < area.left - margin || tile.left > area.right + margin ||
      tile.bottom < area.top - margin || tile.top > area.bottom + margin);
}
