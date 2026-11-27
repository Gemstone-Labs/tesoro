import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPracticeClock } from "./practice-clock";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

// The node test environment has no DOM, so these cover the clock and the source, not a rendered rotation.
describe("a paused practice round across rotation and Home", () => {
  it("keeps its clock still through resize, orientation and visibilitychange events", () => {
    let wall = 5000;
    const clock = createPracticeClock(() => wall);
    const bus = new EventTarget();
    const deadline = clock.now() + 90_000;
    wall += 1000;
    clock.pause();
    const frozen = clock.now();
    for (const type of ["resize", "orientationchange", "visibilitychange"]) {
      bus.addEventListener(type, () => { wall += 7000; });
      bus.dispatchEvent(new Event(type));
    }
    expect(clock.now()).toBe(frozen);
    expect(deadline - clock.now()).toBe(89_000);
    clock.resume();
    wall += 500;
    expect(deadline - clock.now()).toBe(88_500);
  });
  it("has no resize, orientation or visibility handler that could touch the pause", () => {
    for (const f of ["PracticePause.tsx", "GameActions.tsx", "practice-clock.ts"]) {
      expect(read(f)).not.toMatch(/resize|orientation|visibilitychange|matchMedia|innerWidth|innerHeight/);
    }
  });
  it("lays the pause card out for short landscape screens in CSS alone", () => {
    const css = read("practice-pause.css");
    expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: \d+px\)/);
    expect(css).toMatch(/\.practice-paused \{[^}]*overflow-y: auto/);
  });
});
