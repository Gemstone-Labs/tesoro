"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { fitsAt, pieceCells, type Piece, type State } from "./engine";
import { wouldClear } from "./feel";
const COLORS = ["#ffb43a", "#3fc6ff", "#ff4d9b", "#9d74ff"];

/** Preview owns only transient classes, never occupancy. Pointer movement does not enter React. */
export function useBoardPreview(boardRef: RefObject<HTMLDivElement | null>, state: State, piece: Piece | null, readyRef?: RefObject<HTMLDivElement | null>) {
  const painted = useRef(new Map<number, string>());
  const targetKey = useRef<string | null>(null);
  const colorValue = useRef<string | null>(null);
  const readyKey = useRef("");
  const clear = useCallback(() => {
    const cells = boardRef.current?.querySelectorAll("button");
    for (const [i, classes] of painted.current) cells?.[i]?.classList.remove(...classes.split(" "));
    painted.current.clear();
    if (colorValue.current !== null) boardRef.current?.style.removeProperty("--hk");
    targetKey.current = null;
    colorValue.current = null;
    readyKey.current = "";
    const ready = readyRef?.current;
    if (ready?.childElementCount) ready.replaceChildren();
    if (ready?.style.getPropertyValue("--hk")) ready.style.removeProperty("--hk");
  }, [boardRef, readyRef]);
  useLayoutEffect(() => { clear(); return clear; }, [clear, state, piece]);
  // React owns base classes and may replace them when a previous drop finishes.
  // Restore only missing preview tokens before paint, without resetting its target.
  useLayoutEffect(() => {
    const cells = boardRef.current?.querySelectorAll("button");
    for (const [i, classes] of painted.current) {
      const cell = cells?.[i];
      if (!cell) continue;
      const missing = classes.split(" ").filter((token) => !cell.classList.contains(token));
      if (missing.length) cell.classList.add(...missing);
    }
  });
  return useCallback((anchor: { x: number; y: number } | null) => {
    if (!anchor || !piece || !boardRef.current) { clear(); return; }
    const key = `${anchor.x},${anchor.y}`;
    if (targetKey.current === key) return;
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
    if (colorValue.current !== COLORS[color]) {
      boardRef.current.style.setProperty("--hk", COLORS[color]);
      colorValue.current = COLORS[color];
    }
    const ready = readyRef?.current;
    const linesKey = `${hint.rows.join(",")}|${hint.cols.join(",")}`;
    if (ready && readyKey.current !== linesKey) {
      const fragment = ready.ownerDocument.createDocumentFragment();
      for (const [axis, positions] of [["row", hint.rows], ["col", hint.cols]] as const) {
        for (const at of positions) {
          const node = ready.ownerDocument.createElement("span");
          node.className = "bp-ready-line";
          node.dataset.axis = axis;
          if (axis === "row") node.style.gridRow = String(at + 1);
          else node.style.gridColumn = String(at + 1);
          fragment.appendChild(node);
        }
      }
      ready.replaceChildren(fragment);
      readyKey.current = linesKey;
    }
    if (ready && ready.style.getPropertyValue("--hk") !== COLORS[color]) ready.style.setProperty("--hk", COLORS[color]);
    painted.current = next;
    targetKey.current = key;
  }, [boardRef, readyRef, clear, piece, state]);
}
