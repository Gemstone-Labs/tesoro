import { describe, expect, it } from "vitest";
import { sceneA } from "./VariantA";
import { sceneC } from "./VariantC";
import { sceneD } from "./VariantD";
import { sceneE } from "./VariantE";
import { sceneCrystals } from "./crystals";
import type { Frame, Scene } from "./common";

const FRAMES: Frame[] = [
  { w: 1440, h: 900, kind: "wide" },
  { w: 1280, h: 720, kind: "wide" },
  { w: 390, h: 844, kind: "tall" },
];
const SCENES: Record<string, (f: Frame) => Scene> = { A: sceneA, B: sceneCrystals, C: sceneC, D: sceneD, E: sceneE };

describe("divider variants", () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    for (const f of FRAMES) {
      it(`${name} draws finite shapes at ${f.w}x${f.h}`, () => {
        const shapes = scene(f);
        expect(shapes.reduce((n, s) => n + 1 + (s.tones?.length ?? 0), 0)).toBeGreaterThan(2);
        for (const s of shapes) {
          expect(s.body).not.toMatch(/NaN|Infinity/);
          for (const t of s.tones ?? []) expect(t.d).not.toMatch(/NaN|Infinity/);
        }
      });
    }
    it(`${name} is deterministic`, () => expect(scene(FRAMES[0])).toEqual(scene(FRAMES[0])));
  }
});
