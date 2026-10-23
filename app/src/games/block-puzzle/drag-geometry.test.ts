import { describe, expect, it } from "vitest";
import { SHAPES } from "./engine";
import { boardGeometry, dragAnchor, pieceExtent } from "./drag-geometry";

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
});
