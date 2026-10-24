"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { dims, type Piece } from "./engine";
import { dragAnchor, measureGrid, pieceExtent, type GridGeometry } from "./drag-geometry";
import { prefersReducedMotion } from "../fx/reduced-motion";

interface Held {
  idx: number; piece: Piece; grid: GridGeometry; px: number; py: number;
  pickupX: number; pickupY: number; scale: number;
}
interface Gesture {
  held: Held; pointer: number; sx: number; sy: number; moved: boolean;
  offsetX: number; offsetY: number; lift: number; tray: HTMLElement;
}
type Anchor = { x: number; y: number } | null;

export function usePieceDrag({ space, board, preview, place, reject }: {
  space: RefObject<HTMLDivElement | null>; board: RefObject<HTMLDivElement | null>;
  preview: (anchor: Anchor) => void; place: (idx: number, x: number, y: number) => boolean;
  reject: () => void;
}) {
  const [held, setHeld] = useState<Held | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const target = useRef<Anchor>(null);
  const returns = useRef(new Set<HTMLElement>());
  const updatePreview = (next: Anchor) => {
    if (target.current?.x === next?.x && target.current?.y === next?.y) return;
    target.current = next;
    preview(next);
  };
  const cancel = useCallback(() => {
    gesture.current = null;
    target.current = null;
    setHeld(null);
    preview(null);
  }, [preview]);
  useEffect(() => {
    const nodes = returns.current;
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("scroll", cancel, true);
    return () => {
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("scroll", cancel, true);
      nodes.forEach((node) => node.remove());
      nodes.clear();
    };
  }, [cancel]);

  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const m = gesture.current;
    if (!m || m.pointer !== e.pointerId) return;
    if (Math.hypot(e.clientX - m.sx, e.clientY - m.sy) >= 4) m.moved = true;
    // Pointer motion never waits for a game render; only changing a grid target updates React.
    m.held.px = e.clientX - m.offsetX;
    m.held.py = e.clientY - m.offsetY - m.lift;
    if (ghost.current) ghost.current.style.transform = `translate3d(${m.held.px}px, ${m.held.py}px, 0)`;
    if (m.moved) updatePreview(dragAnchor(m.held.piece, m.held.px, m.held.py, m.held.grid));
  };

  const down = (e: ReactPointerEvent<HTMLButtonElement>, idx: number, piece: Piece) => {
    if (gesture.current || !e.isPrimary || e.button !== 0 || !space.current || !board.current) return false;
    const art = e.currentTarget.querySelector<HTMLElement>(".bp-mini");
    if (!art) return false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = art.getBoundingClientRect();
    const grid = measureGrid(space.current, board.current);
    const [w, h] = dims(piece);
    const width = pieceExtent(w, grid);
    const height = pieceExtent(h, grid);
    const offsetX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * width;
    const offsetY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) * height;
    const lift = e.pointerType === "touch" ? 64 : 0;
    const px = e.clientX - offsetX;
    const py = e.clientY - offsetY - lift;
    const value = { idx, piece, grid, px, py, pickupX: rect.left - px, pickupY: rect.top - py, scale: rect.width / width };
    gesture.current = { held: value, pointer: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, offsetX, offsetY, lift, tray: e.currentTarget };
    target.current = null;
    preview(null);
    setHeld({ ...value });
    return true;
  };

  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const m = gesture.current;
    if (!m || m.pointer !== e.pointerId) return;
    move(e);
    const anchor = m.moved ? dragAnchor(m.held.piece, m.held.px, m.held.py, m.held.grid) : null;
    const accepted = anchor && place(m.held.idx, anchor.x, anchor.y);
    if (m.moved && !accepted) {
      reject();
      const node = ghost.current?.cloneNode(true) as HTMLElement | undefined;
      const art = m.tray.querySelector<HTMLElement>(".bp-mini");
      if (node && art && !prefersReducedMotion() && typeof node.animate === "function") {
        const rect = art.getBoundingClientRect();
        node.classList.add("bp-return");
        node.style.transform = `translate3d(${m.held.px}px, ${m.held.py}px, 0)`;
        document.body.appendChild(node);
        returns.current.add(node);
        const animation = node.animate([
          { transform: `translate(${m.held.px}px, ${m.held.py}px) scale(1)`, opacity: 0.95 },
          { transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / pieceExtent(dims(m.held.piece)[0], m.held.grid)})`, opacity: 0.3 },
        ], { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" });
        animation.onfinish = animation.oncancel = () => { node.remove(); returns.current.delete(node); };
      }
    }
    cancel();
  };

  return { held, gesture, ghost, down, move, up, cancel };
}
