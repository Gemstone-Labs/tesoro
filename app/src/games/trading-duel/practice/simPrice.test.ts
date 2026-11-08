import { describe, expect, it } from "vitest";
import { COLUMN_SECS, HEAD_START_SECS, MATCH_SECS, STEP_PPM, bandOf, stepFor } from "../grid";
import { simulatedMid } from "./simPrice";

const START = 150_00000000n;
const sample = (seed: number, asset: "SOL" | "ETH" | "HYPE" = "SOL") => Array.from({ length: MATCH_SECS * 4 }, (_, i) => simulatedMid(seed, START, asset, i / 4));

describe("simulated practice price", () => {
  it("is the same path for the same seed and differs between seeds", () => {
    expect(sample(7)).toEqual(sample(7));
    expect(sample(7)).not.toEqual(sample(8));
  });

  it("starts at the start price", () => {
    expect(simulatedMid(7, START, "SOL", 0)).toBe(START);
    expect(simulatedMid(3, 2000_00000000n, "ETH", 0)).toBe(2000_00000000n);
  });

  it("depends only on elapsed time, so a pause (no time passing) changes nothing", () => {
    const before = simulatedMid(7, START, "SOL", 41.3);
    simulatedMid(7, START, "SOL", 90);
    expect(simulatedMid(7, START, "SOL", 41.3)).toBe(before);
  });

  it("moves about a few boxes per 10 s column, and stays on the grid", () => {
    const step = stepFor(START, STEP_PPM.SOL);
    let crossed = 0;
    let cols = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (let c = 0; c < 12; c++) {
        const from = HEAD_START_SECS + c * COLUMN_SECS;
        const bands = Array.from({ length: 41 }, (_, i) => bandOf(simulatedMid(seed, START, "SOL", from + i / 4), START, step));
        crossed += Math.max(...bands) - Math.min(...bands) + 1;
        cols++;
      }
      const end = bandOf(simulatedMid(seed, START, "SOL", MATCH_SECS), START, step);
      expect(Math.abs(end)).toBeLessThan(60);
    }
    const avg = crossed / cols;
    expect(avg).toBeGreaterThan(1.8);
    expect(avg).toBeLessThan(4.5);
  });
});
