import { fitsAt, type Piece, type State } from "./engine";
import { dragAnchor, type GridGeometry } from "./drag-geometry";

export type DragTarget = { x: number; y: number };
// Approved landing tolerance, expressed in cell pitches so it scales with the board.
const RETENTION_PITCHES = 116 / 106;

export function resolveDragTarget(state: State, piece: Piece, pose: { left: number; top: number }, grid: GridGeometry, previous: DragTarget | null): { anchor: DragTarget | null; retained: boolean } {
  if (!Number.isFinite(pose.left) || !Number.isFinite(pose.top)) return { anchor: null, retained: false };
  const anchor = dragAnchor(piece, pose.left, pose.top, grid);
  if (anchor && fitsAt(state, piece, anchor.x, anchor.y)) return { anchor, retained: false };
  if (previous && fitsAt(state, piece, previous.x, previous.y)
    && Math.abs(pose.left - (grid.left + previous.x * grid.pitch)) <= grid.pitch * RETENTION_PITCHES
    && Math.abs(pose.top - (grid.top + previous.y * grid.pitch)) <= grid.pitch * RETENTION_PITCHES) {
    return { anchor: previous, retained: true };
  }
  return { anchor: null, retained: false };
}
