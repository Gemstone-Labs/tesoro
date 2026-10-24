import { describe, expect, it } from "vitest";
import { SHAPES } from "./engine";
import { boardGeometry, dragAnchor, dragPosition, pickupGeometry, pieceExtent } from "./drag-geometry";

describe("drag geometry", () => {
  const grid = boardGeometry({ left: 14, top: 218, width: 362 }, 9, 4);
  it("accounts for board padding, border and seven gaps", () => {
    expect(grid.cell).toBe(39.5);
    expect(grid.left).toBe(23);
    expect(grid.top).toBe(227);
    expect(pieceExtent(2, grid)).toBe(83);
  });
  it("lands every shape exactly on its preview, including even widths and edges", () => {
    SHAPES.forEach(([w, h], kind) => {
      for (const x of [0, 8 - w]) for (const y of [0, 8 - h]) {
        expect(dragAnchor({ kind, gem: null }, grid.left + x * grid.pitch, grid.top + y * grid.pitch, grid)).toEqual({ x, y });
      }
    });
  });
  it("keeps the same target for subcell movement and rejects drops outside the board", () => {
    const piece = { kind: 7, gem: null };
    expect(dragAnchor(piece, grid.left + 5, grid.top + 4, grid)).toEqual({ x: 0, y: 0 });
    expect(dragAnchor(piece, grid.left, grid.top + 500, grid)).toBeNull();
    expect(dragAnchor(piece, grid.left - 300, grid.top, grid)).toBeNull();
  });
  it("starts touch pieces at tray-art center X and board-bottom center Y even for off-center pickups", () => {
    const rect = { left: 40, top: 600, width: 70, height: 20 };
    SHAPES.forEach((_, kind) => {
      const piece = { kind, gem: null };
      const center = pickupGeometry(piece, rect, { x: 75, y: 610 }, grid, true, 590);
      const edge = pickupGeometry(piece, rect, { x: 42, y: 602 }, grid, true, 590);
      expect(center.left).toBe(edge.left);
      expect(center.top).toBe(edge.top);
      expect(center.left + center.width / 2).toBe(75);
      expect(center.top + center.height / 2).toBe(590);
      expect(center.gain).toBe(1.5);
    });
  });
  it("preserves one-to-one mouse anchoring and reproduces the approved touch displacement", () => {
    const rect = { left: 40, top: 600, width: 70, height: 20 };
    const mouse = pickupGeometry({ kind: 5, gem: null }, rect, { x: 40, y: 600 }, grid, false, 590);
    expect(mouse.left).toBe(40);
    expect(mouse.top).toBe(600);
    expect(mouse.gain).toBe(1);
    const start = { x: 600, y: 2015, left: 467, top: 1590 };
    expect(dragPosition(start, { x: 600, y: 1200 }, 1.5)).toEqual({ left: 467, top: 367.5 });
    expect(dragPosition(start, { x: 700, y: 1700 }, 1.5)).toEqual({ left: 617, top: 1117.5 });
    expect(dragPosition(start, { x: 700, y: 1700 }, 1)).toEqual({ left: 567, top: 1275 });
  });
});
