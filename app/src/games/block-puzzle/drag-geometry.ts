import { dims, SIZE, type Piece } from "./engine";

export interface GridGeometry { left: number; top: number; cell: number; gap: number; pitch: number }

export function boardGeometry(box: { left: number; top: number; width: number }, inset: number, gap: number): GridGeometry {
  const cell = (box.width - inset * 2 - gap * (SIZE - 1)) / SIZE;
  return { left: box.left + inset, top: box.top + inset, cell, gap, pitch: cell + gap };
}

export const pieceExtent = (count: number, grid: GridGeometry) => count * grid.cell + (count - 1) * grid.gap;

export function pickupGeometry(piece: Piece, rect: { left: number; top: number; width: number; height: number }, pointer: { x: number; y: number }, grid: GridGeometry, touch: boolean, boardBottom: number) {
  const [w, h] = dims(piece);
  const width = pieceExtent(w, grid);
  const height = pieceExtent(h, grid);
  if (touch) {
    return { left: rect.left + rect.width / 2 - width / 2, top: boardBottom - height / 2, width, height, gain: 1.5 };
  }
  const offsetX = Math.max(0, Math.min(1, (pointer.x - rect.left) / rect.width)) * width;
  const offsetY = Math.max(0, Math.min(1, (pointer.y - rect.top) / rect.height)) * height;
  return { left: pointer.x - offsetX, top: pointer.y - offsetY, width, height, gain: 1 };
}

export function dragPosition(start: { x: number; y: number; left: number; top: number }, pointer: { x: number; y: number }, gain: number) {
  return { left: start.left + (pointer.x - start.x) * gain, top: start.top + (pointer.y - start.y) * gain };
}

/** Occupied-cell centers choose a grid anchor; outside poses do not clamp to an edge. */
export function dragAnchor(piece: Piece, left: number, top: number, grid: GridGeometry): { x: number; y: number } | null {
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  const [w, h] = dims(piece);
  const x = Math.floor((left - grid.left + grid.cell / 2) / grid.pitch);
  const y = Math.floor((top - grid.top + grid.cell / 2) / grid.pitch);
  return x >= 0 && y >= 0 && x + w <= SIZE && y + h <= SIZE ? { x, y } : null;
}

/** Read from the stationary space, never from the visually shaking board. */
export function measureGrid(space: HTMLElement, board: HTMLElement): GridGeometry {
  const css = getComputedStyle(board);
  return boardGeometry(space.getBoundingClientRect(), parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth), parseFloat(css.columnGap));
}
