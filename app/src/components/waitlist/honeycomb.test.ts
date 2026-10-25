import { describe, expect, it } from "vitest";
import { CLIP_IDS } from "./clips";
import { DRIFT_SPEED, buildHoneycomb, chooseHighlight, isHighlightCandidate } from "./honeycomb";

describe("diagonal honeycomb", () => {
  it.each([[390, 844], [1440, 900], [2560, 1440], [320, 1000]])(
    "covers %i × %i through the complete diagonal loop",
    (width, height) => {
      const grid = buildHoneycomb(width, height);
      expect(grid.columns % 2).toBe(0);
      expect(grid.rise).toBeGreaterThan(0);
      expect(grid.rise / grid.rowStep).toBeCloseTo(grid.riseRows);
      expect(Math.hypot(grid.period, grid.rise) / grid.duration).toBeCloseTo(DRIFT_SPEED);
      expect(grid.period).toBeGreaterThan(width + grid.width);
      expect(grid.rows * grid.rowStep - grid.height / 2).toBeGreaterThan(height);
      expect(new Set(grid.tiles.map((t) => t.clip)).size).toBe(CLIP_IDS.length);
      // At the end of a rightward loop, the preceding staggered column must still fill the left edge.
      const leading = grid.loopTiles.filter((tile) => tile.x < 0);
      expect(leading).toHaveLength(grid.rows);
      expect(leading.every((tile) => tile.x === -grid.columnStep)).toBe(true);
      // Even column counts preserve stagger at the wrap; neighbors must not repeat a clip there either.
      for (const tile of grid.tiles) {
        expect(CLIP_IDS).toContain(tile.clip);
        const sameColumn = grid.tiles.find((t) => t.column === tile.column && t.row === tile.row + 1);
        if (sameColumn) expect(tile.clip).not.toBe(sameColumn.clip);
        const nextColumn = (tile.column + 1) % grid.columns;
        const wrap = tile.column === grid.columns - 1 ? grid.riseRows : 0;
        for (const row of [tile.row + wrap, tile.row + wrap + (tile.column % 2 ? 1 : -1)]) {
          const neighbor = grid.tiles.find((t) => t.column === nextColumn && t.row === row);
          if (neighbor) expect(tile.clip).not.toBe(neighbor.clip);
        }
      }
      for (const tile of grid.tiles) {
        const first = grid.loopTiles.find((t) => t.id === `0-${tile.id}`)!;
        const second = grid.loopTiles.find((t) => t.id === `1-${tile.id}`)!;
        expect(second.x - grid.period).toBeCloseTo(first.x);
        expect(second.y + grid.rise).toBeCloseTo(first.y);
        expect(second.clip).toBe(first.clip);
      }
    },
  );

  it("selects one eligible tile and avoids immediately repeating it", () => {
    expect(chooseHighlight(["a", "b", "c"], "a", () => 0)).toBe("b");
    expect(chooseHighlight(["a", "b", "c"], "a", () => 0.999)).toBe("c");
    expect(chooseHighlight(["a"], "a", () => 0)).toBe("a");
    expect(chooseHighlight([], "a", () => 0)).toBeNull();
  });

  it("keeps highlights away from the form, header and clipped viewport edges", () => {
    const viewport = { left: 0, top: 0, right: 1440, bottom: 900 };
    const form = { left: 420, top: 300, right: 1020, bottom: 750 };
    expect(isHighlightCandidate({ left: 30, top: 120, right: 260, bottom: 320 }, viewport, [form])).toBe(true);
    expect(isHighlightCandidate({ left: 360, top: 250, right: 600, bottom: 450 }, viewport, [form])).toBe(false);
    expect(isHighlightCandidate({ left: -20, top: 120, right: 210, bottom: 320 }, viewport, [form])).toBe(false);
    expect(isHighlightCandidate({ left: 30, top: 10, right: 260, bottom: 210 }, viewport, [form])).toBe(false);
  });
});
