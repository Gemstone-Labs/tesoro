"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { dims, type Piece, type State } from "./engine";
import { dragPosition, measureGrid, pickupGeometry, pieceExtent, type GridGeometry } from "./drag-geometry";
import { resolveDragTarget, type DragTarget } from "./drag-target";
import { prefersReducedMotion } from "../fx/reduced-motion";

interface Held {
  idx: number; piece: Piece; grid: GridGeometry; px: number; py: number;
  pickupX: number; pickupY: number; scale: number; touch: boolean;
}
interface Gesture {
  held: Held; pointer: number; sx: number; sy: number; moved: boolean;
  latestX: number; latestY: number; startLeft: number; startTop: number;
  gain: number; tray: HTMLElement; lastValid: DragTarget | null;
}
type Anchor = DragTarget | null;

export function usePieceDrag({ space, board, getState, preview, place, reject }: {
  space: RefObject<HTMLDivElement | null>; board: RefObject<HTMLDivElement | null>;
  getState: () => State;
  preview: (anchor: Anchor) => void; place: (idx: number, x: number, y: number) => boolean;
  reject: () => void;
}) {
  const [held, setHeld] = useState<Held | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const target = useRef<Anchor>(null);
  const returns = useRef(new Set<HTMLElement>());
  const updatePreview = useCallback((next: Anchor) => {
    if (target.current?.x === next?.x && target.current?.y === next?.y) return;
    target.current = next;
    preview(next);
  }, [preview]);
  const cancel = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    target.current = null;
    if (active?.tray.hasPointerCapture(active.pointer)) active.tray.releasePointerCapture(active.pointer);
    setHeld(null);
    preview(null);
  }, [preview]);
  const updateLanding = useCallback((active: Gesture) => {
    const next = resolveDragTarget(getState(), active.held.piece, { left: active.held.px, top: active.held.py }, active.held.grid, active.lastValid);
    if (next.anchor && !next.retained) active.lastValid = next.anchor;
    updatePreview(next.anchor);
  }, [getState, updatePreview]);

  useEffect(() => {
    const nodes = returns.current;
    let viewportWidth = window.innerWidth;
    const refreshViewport = () => {
      const active = gesture.current;
      if (!active || !space.current || !board.current) return;
      const grid = measureGrid(space.current, board.current);
      const previous = active.held.grid;
      const resized = grid.cell !== previous.cell || grid.gap !== previous.gap;
      if (resized) {
        const [w, h] = dims(active.held.piece);
        active.held.px += (pieceExtent(w, previous) - pieceExtent(w, grid)) / 2;
        active.held.py += (pieceExtent(h, previous) - pieceExtent(h, grid)) / 2;
        if (ghost.current) ghost.current.style.transform = `translate3d(${active.held.px}px, ${active.held.py}px, 0)`;
      }
      active.held.grid = grid;
      active.sx = active.latestX; active.sy = active.latestY;
      active.startLeft = active.held.px; active.startTop = active.held.py;
      if (resized) setHeld({ ...active.held });
      if (active.moved) updateLanding(active);
    };
    const resize = () => {
      const widthChanged = window.innerWidth !== viewportWidth;
      viewportWidth = window.innerWidth;
      if (widthChanged) cancel();
      else refreshViewport();
    };
    window.addEventListener("resize", resize);
    window.addEventListener("blur", cancel);
    window.addEventListener("scroll", refreshViewport, true);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("scroll", refreshViewport, true);
      nodes.forEach((node) => node.remove());
      nodes.clear();
    };
  }, [space, board, cancel, updateLanding]);

  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== e.pointerId) return;
    active.latestX = e.clientX; active.latestY = e.clientY;
    if (Math.hypot(e.clientX - active.sx, e.clientY - active.sy) >= 4) active.moved = true;
    const pose = dragPosition({ x: active.sx, y: active.sy, left: active.startLeft, top: active.startTop }, { x: e.clientX, y: e.clientY }, active.gain);
    active.held.px = pose.left; active.held.py = pose.top;
    if (ghost.current) ghost.current.style.transform = `translate3d(${pose.left}px, ${pose.top}px, 0)`;
    if (active.moved) updateLanding(active);
  };

  const down = (e: ReactPointerEvent<HTMLButtonElement>, idx: number, piece: Piece) => {
    if (gesture.current || !e.isPrimary || e.button !== 0 || !space.current || !board.current) return false;
    const art = e.currentTarget.querySelector<HTMLElement>(".bp-mini");
    if (!art) return false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = art.getBoundingClientRect();
    const grid = measureGrid(space.current, board.current);
    const touch = e.pointerType === "touch";
    const pickup = pickupGeometry(piece, rect, { x: e.clientX, y: e.clientY }, grid, touch, space.current.getBoundingClientRect().bottom);
    const value: Held = { idx, piece, grid, px: pickup.left, py: pickup.top, pickupX: rect.left - pickup.left, pickupY: rect.top - pickup.top, scale: rect.width / pickup.width, touch };
    gesture.current = {
      held: value, pointer: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false,
      latestX: e.clientX, latestY: e.clientY, startLeft: pickup.left, startTop: pickup.top,
      gain: pickup.gain, tray: e.currentTarget, lastValid: null,
    };
    target.current = null;
    preview(null);
    setHeld({ ...value });
    return true;
  };

  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== e.pointerId) return;
    // The displayed legal preview is the release target; pointer-up cannot resnap it.
    const anchor = active.moved ? target.current : null;
    const accepted = anchor && place(active.held.idx, anchor.x, anchor.y);
    if (active.moved && !accepted) {
      reject();
      const node = ghost.current?.cloneNode(true) as HTMLElement | undefined;
      const art = active.tray.querySelector<HTMLElement>(".bp-mini");
      if (node && art && !prefersReducedMotion() && typeof node.animate === "function") {
        const rect = art.getBoundingClientRect();
        node.classList.add("bp-return");
        node.style.transform = `translate3d(${active.held.px}px, ${active.held.py}px, 0)`;
        document.body.appendChild(node);
        returns.current.add(node);
        const animation = node.animate([
          { transform: `translate(${active.held.px}px, ${active.held.py}px) scale(1)`, opacity: 0.95 },
          { transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / pieceExtent(dims(active.held.piece)[0], active.held.grid)})`, opacity: 0.3 },
        ], { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" });
        animation.onfinish = animation.oncancel = () => { node.remove(); returns.current.delete(node); };
      }
    }
    cancel();
  };

  return { held, gesture, ghost, down, move, up, cancel };
}
