import { describe, expect, it } from "vitest";
import { SHAPES, newState, type Piece } from "./engine";
import { resolveDragTarget } from "./drag-target";

const grid = { left: 20, top: 100, cell: 40, gap: 4, pitch: 44 };
const bar: Piece = { kind: 5, gem: null };
const pose = (x: number, y: number) => ({ left: grid.left + x * grid.pitch, top: grid.top + y * grid.pitch });
const state = { ...newState(22n), occ: 0xfn << 24n };

describe("drag landing", () => {
  it("keeps a nearby legal preview during an occupied-cell excursion", () => {
    const target = resolveDragTarget(state, bar, pose(4, 3), grid, null);
    expect(target).toEqual({ anchor: { x: 4, y: 3 }, retained: false });
    expect(resolveDragTarget(state, bar, pose(3.4, 3), grid, target.anchor))
      .toEqual({ anchor: { x: 4, y: 3 }, retained: true });
  });
  it("clears the landing beyond its retention region instead of clamping outside poses", () => {
    expect(resolveDragTarget(state, bar, pose(2.8, 3), grid, { x: 4, y: 3 }).anchor).toBeNull();
    expect(resolveDragTarget(state, bar, pose(-2, 0), grid, null).anchor).toBeNull();
    expect(resolveDragTarget(state, bar, pose(4, -4), grid, { x: 4, y: 3 }).anchor).toBeNull();
  });
  it("prefers a new legal landing and revalidates any previously visible target", () => {
    expect(resolveDragTarget(state, bar, pose(3, 2), grid, { x: 4, y: 3 }))
      .toEqual({ anchor: { x: 3, y: 2 }, retained: false });
    const changed = { ...state, occ: state.occ | (1n << 28n) };
    expect(resolveDragTarget(changed, bar, pose(3.4, 3), grid, { x: 4, y: 3 }).anchor).toBeNull();
  });
  it("uses occupied-cell centers at gaps and rejects nonfinite coordinates", () => {
    expect(resolveDragTarget(newState(22n), bar, pose(.52, 0), grid, null).anchor).toEqual({ x: 0, y: 0 });
    expect(resolveDragTarget(state, bar, { left: NaN, top: 200 }, grid, null).anchor).toBeNull();
  });
  it("maps all shapes, including even widths, to exact legal edge anchors", () => {
    SHAPES.forEach(([width, height], kind) => {
      for (const x of [0, 8 - width]) for (const y of [0, 8 - height]) {
        expect(resolveDragTarget(newState(22n), { kind, gem: null }, pose(x, y), grid, null).anchor).toEqual({ x, y });
      }
    });
  });
});
