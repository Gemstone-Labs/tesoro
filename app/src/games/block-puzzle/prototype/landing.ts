import { fitsAt, type Piece, type State } from "../engine";
import type { GridGeometry } from "../drag-geometry";

export type Landing = { x: number; y: number };
// Source-backed prototype candidate. Footage shows stable previews but does not
// establish active hysteresis or its tolerance. Source default is 116 / 106 pitches.
const RETENTION_PITCHES = 116 / 106;

export function resolveDragTarget(state: State, piece: Piece, pose: { left: number; top: number }, grid: GridGeometry, previous: Landing | null): { anchor: Landing | null; retained: boolean } {
  if (!Number.isFinite(pose.left) || !Number.isFinite(pose.top)) return { anchor: null, retained: false };
  const x = Math.floor((pose.left - grid.left + grid.cell / 2) / grid.pitch);
  const y = Math.floor((pose.top - grid.top + grid.cell / 2) / grid.pitch);
  if (fitsAt(state, piece, x, y)) return { anchor: { x, y }, retained: false };
  if (previous && fitsAt(state, piece, previous.x, previous.y)
    && Math.abs(pose.left - (grid.left + previous.x * grid.pitch)) <= grid.pitch * RETENTION_PITCHES
    && Math.abs(pose.top - (grid.top + previous.y * grid.pitch)) <= grid.pitch * RETENTION_PITCHES) {
    return { anchor: previous, retained: true };
  }
  return { anchor: null, retained: false };
}
