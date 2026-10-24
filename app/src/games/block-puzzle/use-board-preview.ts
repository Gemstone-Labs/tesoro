"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { fitsAt, pieceCells, type Piece, type State } from "./engine";
import { wouldClear } from "./feel";
const COLORS = ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"];

/** Preview owns only transient classes, never occupancy. Pointer movement does not enter React. */
export function useBoardPreview(boardRef: RefObject<HTMLDivElement | null>, state: State, piece: Piece | null) {
  const painted = useRef(new Map<number, string>());
  const clear = useCallback(() => {
    const cells = boardRef.current?.querySelectorAll("button");
    for (const [i, classes] of painted.current) cells?.[i]?.classList.remove(...classes.split(" "));
    painted.current.clear();
    boardRef.current?.style.removeProperty("--hk");
  }, [boardRef]);
  useLayoutEffect(() => { clear(); return clear; }, [clear, state, piece]);
  return useCallback((anchor: { x: number; y: number } | null) => {
    if (!anchor || !piece || !boardRef.current) { clear(); return; }
    const valid = fitsAt(state, piece, anchor.x, anchor.y);
    const color = piece.kind % 4;
    const footprint = new Set(pieceCells(piece).map(c => (anchor.y + c.dy) * 8 + anchor.x + c.dx));
    const hint = valid ? wouldClear(state, piece, anchor.x, anchor.y) : {rows: [], cols: []};
    const next = new Map<number, string>();
    for (let i = 0; i < 64; i++) {
      const classes = [];
      if (footprint.has(i)) classes.push("pv", valid ? `pk${color}` : "bad");
      if (hint.rows.includes(Math.floor(i / 8)) || hint.cols.includes(i % 8)) classes.push("hint");
      if (classes.length) next.set(i, classes.join(" "));
    }
    const cells = boardRef.current.querySelectorAll("button");
    for (const i of new Set([...painted.current.keys(), ...next.keys()])) {
      const before = painted.current.get(i), after = next.get(i);
      if (before === after) continue;
      if (before) cells[i]?.classList.remove(...before.split(" "));
      if (after) cells[i]?.classList.add(...after.split(" "));
    }
    boardRef.current.style.setProperty("--hk", COLORS[color]);
    painted.current = next;
  }, [boardRef, clear, piece, state]);
}
