import { dims, SIZE, type Piece } from "./engine";

export interface GridGeometry { left: number; top: number; cell: number; gap: number; pitch: number }

export function boardGeometry(box: { left: number; top: number; width: number }, inset: number, gap: number): GridGeometry {
  const cell = (box.width - inset * 2 - gap * (SIZE - 1)) / SIZE;
  return { left: box.left + inset, top: box.top + inset, cell, gap, pitch: cell + gap };
}

export const pieceExtent = (count: number, grid: GridGeometry) => count * grid.cell + (count - 1) * grid.gap;

/** The held piece's top-left and the preview share the same geometry, including even-width shapes. */
export function dragAnchor(piece: Piece, left: number, top: number, grid: GridGeometry): { x: number; y: number } | null {
  const [w, h] = dims(piece);
  const cx = left + pieceExtent(w, grid) / 2;
  const cy = top + pieceExtent(h, grid) / 2;
  const extent = pieceExtent(SIZE, grid);
  if (cx < grid.left - grid.cell / 2 || cy < grid.top - grid.cell / 2 || cx > grid.left + extent + grid.cell / 2 || cy > grid.top + extent + grid.cell / 2) return null;
  return {
    x: Math.max(0, Math.min(SIZE - w, Math.round((left - grid.left) / grid.pitch))),
    y: Math.max(0, Math.min(SIZE - h, Math.round((top - grid.top) / grid.pitch))),
  };
}

/** Read from the stationary space, never from the visually shaking board. */
export function measureGrid(space: HTMLElement, board: HTMLElement): GridGeometry {
  const css = getComputedStyle(board);
  return boardGeometry(space.getBoundingClientRect(), parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth), parseFloat(css.columnGap));
}
