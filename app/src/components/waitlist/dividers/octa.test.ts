import { describe, expect, it } from "vitest";
import { LINES } from "../geometry";
import { dividerScene, gemSize, growth } from "./octa";
import type { Frame } from "./geo";

const FRAMES: Frame[] = [
  { w: 1440, h: 900, kind: "wide" },
  { w: 1280, h: 720, kind: "wide" },
  { w: 390, h: 844, kind: "tall" },
];

describe("the split", () => {
  it("divides the wide frame about in half", () => {
    const { x1, x2 } = LINES.wide;
    expect((x1 + x2) / 2).toBeCloseTo(0.5, 1);
  });
});

describe("the growth", () => {
  for (const f of FRAMES) {
    const name = `${f.w}x${f.h}`;
    it(`${name}: grown gems are connected to the band, breakaways stand apart and are few`, () => {
      const gr = growth(f);
      const grown = gr.sites.filter((s) => gr.at(s.i, s.j) === 2);
      const away = gr.sites.filter((s) => gr.at(s.i, s.j) === 3);
      expect(grown.length).toBeGreaterThan(10);
      for (const s of grown) {
        expect([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => [1, 2].includes(gr.at(s.i + a, s.j + b)))).toBe(true);
      }
      for (const s of away) {
        for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) expect([1, 2]).not.toContain(gr.at(s.i + a, s.j + b));
      }
      expect(away.length).toBeLessThanOrEqual(Math.max(3, Math.ceil(grown.length * 0.1)));
    });

    it(`${name}: the band is solid and the growth stays within reach`, () => {
      const gr = growth(f);
      const { band, unit } = gr.fl;
      expect(Math.max(...gr.sites.filter((s) => gr.at(s.i, s.j) === 2).map((s) => s.d - band))).toBeLessThanOrEqual(270 * unit);
      for (const s of gr.sites) if (s.d <= band) expect(gr.at(s.i, s.j)).toBe(1);
    });

    it(`${name}: finite shapes, the same ones each time`, () => {
      const a = dividerScene(f);
      expect(a.gems.length).toBeGreaterThan(2000);
      expect(a.gems + a.ground).not.toMatch(/NaN|Infinity/);
      expect(dividerScene(f)).toEqual(a);
    });
  }
});

describe("gem size", () => {
  it("is fused at the foot of a finger and opens to 72% at the tip", () => {
    expect(gemSize(0)).toBe(1);
    expect(gemSize(1)).toBeCloseTo(0.72);
    expect(gemSize(0.5)).toBeGreaterThan(gemSize(1));
    expect(gemSize(2)).toBeCloseTo(0.72);
    expect(gemSize(-1)).toBe(1);
  });
});
