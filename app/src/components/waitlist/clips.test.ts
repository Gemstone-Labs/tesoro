import { describe, expect, it } from "vitest";
import { CLIP_IDS, SIMILAR, WALL, WALL_COLUMNS, WALL_ROWS, buildColumns } from "./clips";

const clash = (a: number, b: number) => a === b || SIMILAR.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

describe("wall layout", () => {
  it("has the columns and rows it promises, from known clips", () => {
    expect(WALL).toHaveLength(WALL_COLUMNS);
    for (const col of WALL) {
      expect(col).toHaveLength(WALL_ROWS);
      col.forEach((id) => expect(CLIP_IDS).toContain(id));
    }
  });

  it("never puts identical or similar clips next to each other, in a column (looping) or across columns", () => {
    WALL.forEach((col, c) => {
      col.forEach((id, r) => {
        for (const d of [1, 2]) expect(clash(id, col[(r + d) % WALL_ROWS])).toBe(false);
        const right = WALL[c + 1];
        if (right) for (const d of [-1, 0, 1]) expect(clash(id, right[(r + d + WALL_ROWS) % WALL_ROWS])).toBe(false);
      });
    });
  });

  it("is deterministic", () => expect(buildColumns()).toEqual(WALL));

  it("uses most of the pool", () => expect(new Set(WALL.flat()).size).toBeGreaterThanOrEqual(CLIP_IDS.length - 1));
});
