import { describe, expect, it } from "vitest";
import { CRASH_MS, CRASH_REDUCED_MS, crashHold } from "./crash";
import { riding, workedResult } from "./fixtures";

describe("the crash moment before the Result", () => {
  it("a ride turning into its Result keeps the ride screen to play the impact", () => {
    const ride = riding();
    expect(crashHold(ride, workedResult(), null)).toBe(ride);
  });

  it("keeps the same ride screen while the Result view updates, and lets go when the hold is cleared", () => {
    const ride = riding();
    const held = crashHold(ride, workedResult(), null);
    expect(crashHold(workedResult(), workedResult(), held)).toBe(ride);
    expect(crashHold(workedResult(), workedResult(), null)).toBeNull();
  });

  it("a page that opens on a Result, or a ride that is still going, holds nothing", () => {
    expect(crashHold(workedResult(), workedResult(), null)).toBeNull();
    expect(crashHold(riding(), riding(), null)).toBeNull();
  });

  it("lasts about a second, and less with reduced motion", () => {
    expect(CRASH_MS).toBeGreaterThanOrEqual(800);
    expect(CRASH_MS).toBeLessThanOrEqual(1200);
    expect(CRASH_REDUCED_MS).toBeLessThan(CRASH_MS);
  });
});
