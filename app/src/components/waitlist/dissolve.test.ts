import { describe, expect, it } from "vitest";
import { LINES } from "./geometry";
import { TILE, TILE_CENTRE, dissolveCells } from "./dissolve";

describe("dissolve cells", () => {
  it("snap to the texture grid: centres step by a divisor of the tile from the texture octagon's centre", () => {
    for (const [w, h, variant, pitch] of [[1440, 900, "wide", 90], [390, 760, "tall", 60]] as const) {
      expect(TILE % pitch).toBe(0);
      for (const c of dissolveCells(w, h, variant)) {
        expect(Math.abs((c.x - TILE_CENTRE.x) % pitch)).toBe(0);
        expect(Math.abs((c.y - TILE_CENTRE.y) % pitch)).toBe(0);
      }
    }
  });

  it("are solid at the diagonal and thin out and shrink towards the footage", () => {
    const cells = dissolveCells(1440, 900, "wide");
    const { x1, y1, x2, y2 } = LINES.wide;
    const [dx, dy] = [(x2 - x1) * 1440, (y2 - y1) * 900];
    const len = Math.hypot(dx, dy);
    const dist = (c: { x: number; y: number }) => ((c.x - x1 * 1440) * dy - (c.y - y1 * 900) * dx) / len;
    const near = cells.filter((c) => Math.abs(dist(c)) < 90);
    const far = cells.filter((c) => Math.abs(dist(c)) > 300);
    expect(near.length).toBeGreaterThan(far.length);
    const mean = (cs: typeof cells) => cs.reduce((a, c) => a + c.scale, 0) / cs.length;
    expect(mean(far)).toBeLessThan(mean(near) * 0.7);
    expect(Math.max(...cells.map((c) => Math.abs(dist(c))))).toBeLessThanOrEqual(540);
  });

  it("are deterministic", () => expect(dissolveCells(1280, 720, "wide")).toEqual(dissolveCells(1280, 720, "wide")));
});
