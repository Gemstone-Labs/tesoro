import { SIZE, footprint, fitsAt, dims, type Piece, type State } from "./engine";

const ROW0 = 0xffn;
const COL0 = 0x0101010101010101n;

/** The rows and columns that placing `piece` at (x, y) would complete: what the engine will clear. */
export function wouldClear(st: State, piece: Piece, x: number, y: number): { rows: number[]; cols: number[] } {
  const none = { rows: [], cols: [] };
  const [w, h] = dims(piece);
  if (x < 0 || y < 0 || x + w > SIZE || y + h > SIZE || !fitsAt(st, piece, x, y)) return none;
  const occ = st.occ | (footprint(piece).bits << BigInt(y * SIZE + x));
  const rows: number[] = [];
  const cols: number[] = [];
  for (let i = 0; i < SIZE; i++) {
    const row = ROW0 << BigInt(i * SIZE);
    if ((occ & row) === row) rows.push(i);
    const col = COL0 << BigInt(i);
    if ((occ & col) === col) cols.push(i);
  }
  return { rows, cols };
}

/** Punchy line for a clear, at the clear location. */
export function clearCallout(lines: number, gems: number, combo: number): string | null {
  const big = lines >= 4 ? "Board shaker!" : lines === 3 ? "Triple!" : lines === 2 ? "Double!" : null;
  if (gems > 0) return big ? `${big} Gem ×${1 + gems}` : `Gem ×${1 + gems}`;
  if (big) return big;
  return combo >= 2 ? `Combo ×${combo}` : lines > 0 ? "Line!" : null;
}

/** How hot the combo meter burns, 0 (cold) to 4. */
export function comboHeat(combo: number): 0 | 1 | 2 | 3 | 4 {
  if (combo <= 0) return 0;
  if (combo === 1) return 1;
  if (combo === 2) return 2;
  return combo <= 4 ? 3 : 4;
}
