import { describe, expect, it } from "vitest";
import { heldPosition, pickupGeometry, placementTarget } from "./motion";
import { boardGeometry } from "../drag-geometry";

describe("measured prototype motion", () => {
  it("reproduces the independently measured Seeker displacement", () => {
    const start = { x: 600, y: 2015, left: 467, top: 1590 };
    expect(heldPosition(start, { x: 600, y: 1200 }, 1.5)).toEqual({ left: 467, top: 367.5 });
    expect(heldPosition(start, { x: 700, y: 1700 }, 1.5)).toEqual({ left: 617, top: 1117.5 });
    expect(heldPosition(start, { x: 600, y: 1200 }, 1)).toEqual({ left: 467, top: 775 });
  });
  it("anchors to the tray art and board bottom independently of where the finger picks up", () => {
    const grid = boardGeometry({ left: 0, top: 0, width: 400 }, 9, 4);
    const rect = { left: 100, top: 500, width: 80, height: 20 };
    const p = { x: 140, y: 510 };
    const centered = pickupGeometry({ kind: 5, gem: null }, rect, p, grid, "combined", true, 410);
    const offCenter = pickupGeometry({ kind: 5, gem: null }, rect, { x: 105, y: 503 }, grid, "combined", true, 410);
    expect(centered.left).toBeCloseTo(offCenter.left);
    expect(centered.top).toBeCloseTo(410 - centered.height / 2);
    expect(offCenter.top).toBe(centered.top);
    expect(centered.lift).toBe(100);
    expect(pickupGeometry({ kind: 5, gem: null }, rect, p, grid, "current", true).lift).toBe(64);
    expect(pickupGeometry({ kind: 5, gem: null }, rect, p, grid, "combined", false).gain).toBe(1);
  });
  it("keeps a last valid preview from accepting an outside release", () => {
    const grid = boardGeometry({ left: 20, top: 100, width: 360 }, 9, 4);
    const piece = { kind: 5, gem: null };
    expect(placementTarget(piece, 29, 109, grid)).toEqual({ x: 0, y: 0 });
    expect(placementTarget(piece, 29, -200, grid)).toBeNull();
  });
});
