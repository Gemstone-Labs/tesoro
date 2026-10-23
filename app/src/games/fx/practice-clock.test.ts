import { describe, expect, it } from "vitest";
import { createPracticeClock } from "./practice-clock";

// Both deadline clocks and Trading Duel's elapsed time use this same logical time.
describe("practice clock", () => {
  it("excludes paused time, including repeated pauses, and resumes the same deadline", () => {
    let wall = 1000;
    const clock = createPracticeClock(() => wall);
    const deadline = clock.now() + 90_000;
    wall += 1250;
    clock.pause();
    const left = deadline - clock.now();
    wall += 20_000;
    clock.pause();
    expect(deadline - clock.now()).toBe(left);
    clock.resume();
    clock.resume();
    wall += 750;
    expect(deadline - clock.now()).toBe(left - 750);
    clock.pause();
    wall += 9000;
    expect(clock.now()).toBe(3000);
    clock.resume();
    wall += 500;
    expect(clock.now()).toBe(3500);
  });
});
