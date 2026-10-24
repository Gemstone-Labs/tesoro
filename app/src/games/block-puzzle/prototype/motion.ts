/** Own implementation from controlled device measurements, not recovered code.
 * Seeker: pointer dy=-815, held-piece dy=-1223 (~1.5x); initial center at board bottom.
 * Readable source independently corroborates relative motion and board-bottom pickup.
 * The baseline matches use-piece-drag.ts at 934571f2. No production hook is changed.
 */
import { dragAnchor, type GridGeometry } from "../drag-geometry";
import { dims, type Piece } from "../engine";

export type Variant = "current" | "motion" | "credit" | "combined" | "previous";
export const measuredMotion = (variant: Variant) => variant === "motion" || variant === "combined" || variant === "previous";
export const splitCredit = (variant: Variant) => variant === "credit" || variant === "combined" || variant === "previous";
export const refinedInteractions = (variant: Variant) => variant === "motion" || variant === "combined";

export function heldPosition(start: { x: number; y: number; left: number; top: number }, pointer: { x: number; y: number }, gain: number) {
  return { left: start.left + (pointer.x - start.x) * gain, top: start.top + (pointer.y - start.y) * gain };
}

/** Current clamping is retained. Edge magnetism is not established by the native probes. */
export function placementTarget(piece: Piece, left: number, top: number, grid: GridGeometry) {
  return dragAnchor(piece, left, top, grid);
}

export function pickupGeometry(piece: Piece, rect: { left: number; top: number; width: number; height: number }, pointer: { x: number; y: number }, grid: GridGeometry, variant: Variant, touch: boolean, boardBottom = grid.top + grid.pitch * 8 - grid.gap) {
  const [w, h] = dims(piece);
  const width = w * grid.cell + (w - 1) * grid.gap;
  const height = h * grid.cell + (h - 1) * grid.gap;
  if (touch && measuredMotion(variant)) {
    return { left: rect.left + rect.width / 2 - width / 2, top: boardBottom - height / 2,
      width, height, gain: 1.5, lift: pointer.y - boardBottom, scale: rect.width / width };
  }
  const lift = touch ? 64 : 0;
  const offsetX = Math.max(0, Math.min(1, (pointer.x - rect.left) / rect.width)) * width;
  const offsetY = Math.max(0, Math.min(1, (pointer.y - rect.top) / rect.height)) * height;
  return { left: pointer.x - offsetX, top: pointer.y - offsetY - lift, width, height,
    gain: touch && measuredMotion(variant) ? 1.5 : 1, lift, scale: rect.width / width };
}
