import { describe, expect, it } from "vitest";
import { LINES } from "../geometry";
import { bayer, dividerScene, field, siteAt, threshold } from "./octa";
import type { Frame } from "./geo";

const FRAMES: Frame[] = [
  { w: 1440, h: 900, kind: "wide" },
  { w: 1280, h: 720, kind: "wide" },
  { w: 390, h: 844, kind: "tall" },
];

describe("the divider", () => {
  it("splits the wide frame about in half", () => {
    const { x1, x2 } = LINES.wide;
    expect((x1 + x2) / 2).toBeCloseTo(0.5, 1);
  });

  it("draws finite shapes at every size, and the same ones each time", () => {
    for (const f of FRAMES) {
      const a = dividerScene(f);
      expect(a.gems.length).toBeGreaterThan(2000);
      expect(a.gems + a.ground).not.toMatch(/NaN|Infinity/);
      expect(dividerScene(f)).toEqual(a);
    }
  });

  it("is solid next to the panel: every site in the solid zone has a gem", () => {
    for (const f of FRAMES) {
      const fl = field(f);
      let solid = 0;
      for (let i = -5; i < 60; i++) {
        for (let j = -5; j < 40; j++) {
          const s = siteAt(fl, i, j);
          if (s.solid) {
            solid++;
            expect(s.on).toBe(true);
          }
        }
      }
      expect(solid).toBeGreaterThan(50);
    }
  });

  it("comes apart cleanly: past the solid zone no two gems touch side by side", () => {
    for (const f of FRAMES) {
      const fl = field(f);
      for (let i = -5; i < 60; i++) {
        for (let j = -5; j < 40; j++) {
          const a = siteAt(fl, i, j);
          if (a.solid || !a.on) continue;
          for (const [di, dj] of [[1, 0], [0, 1]]) {
            const b = siteAt(fl, i + di, j + dj);
            if (!b.solid) expect(b.on).toBe(false);
          }
        }
      }
    }
  });
});

describe("ordered dither", () => {
  it("a Bayer matrix holds every threshold once", () => {
    expect(bayer(8).flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });
  it("thresholds sit strictly between 0 and 1", () => {
    for (let i = -9; i < 9; i++) {
      for (let j = -9; j < 9; j++) {
        expect(threshold(i, j)).toBeGreaterThan(0);
        expect(threshold(i, j)).toBeLessThan(1);
      }
    }
  });
});
