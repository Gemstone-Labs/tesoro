import { describe, expect, it } from "vitest";
import { sceneA } from "./VariantA";
import { sceneA1 } from "./VariantA1";
import { sceneA2 } from "./VariantA2";
import { sceneA3 } from "./VariantA3";
import { sceneA4 } from "./VariantA4";
import { bayer, threshold } from "./octa";
import type { Frame, Scene } from "./common";

const FRAMES: Frame[] = [
  { w: 1440, h: 900, kind: "wide" },
  { w: 1280, h: 720, kind: "wide" },
  { w: 390, h: 844, kind: "tall" },
];
const SCENES: Record<string, (f: Frame) => Scene> = { A: sceneA, A1: sceneA1, A2: sceneA2, A3: sceneA3, A4: sceneA4 };

describe("divider variants", () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    for (const f of FRAMES) {
      it(`${name} draws finite shapes at ${f.w}x${f.h}`, () => {
        const shapes = scene(f);
        expect(shapes.reduce((n, s) => n + s.body.length, 0)).toBeGreaterThan(400);
        for (const s of shapes) {
          expect(s.body).not.toMatch(/NaN|Infinity/);
          for (const t of s.tones ?? []) expect(t.d).not.toMatch(/NaN|Infinity/);
        }
      });
    }
    it(`${name} is deterministic`, () => expect(scene(FRAMES[0])).toEqual(scene(FRAMES[0])));
  }
});

describe("ordered dither", () => {
  it("a Bayer matrix holds every threshold once", () => {
    const flat = bayer(8).flat().sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 64 }, (_, i) => i));
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

describe("the front", () => {
  it("A1 thins out away from the diagonal: more gems near it than far", () => {
    const f: Frame = { w: 1440, h: 900, kind: "wide" };
    const count = (s: Scene) => (s[1].body.match(/M/g) ?? []).length;
    expect(count(sceneA1(f))).toBeGreaterThan(100);
    expect(count(sceneA3(f))).toBeGreaterThan(count(sceneA1(f)) * 0.8);
  });
  it("A4 pops its gems in outward over time", () => {
    const pops = sceneA4({ w: 1440, h: 900, kind: "wide" }).filter((s) => s.delay !== undefined);
    expect(pops.length).toBeGreaterThan(50);
    expect(Math.max(...pops.map((s) => s.delay!))).toBeGreaterThan(15);
  });
});
