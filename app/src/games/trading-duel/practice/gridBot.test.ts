import { describe, expect, it } from "vitest";
import { NO_PICK, STEP_PPM, columnStart, finish, newTrack, record, settle, stepFor } from "../grid";
import { botPickTimes, botRow } from "./gridBot";
import { seededRng } from "./bot";

/** A random walk at the calibrated one-second volatility of SOL (about 67 ppm per second). */
function path(rng: () => number, anchor: number): number[] {
  const out: number[] = [];
  let p = anchor;
  for (let i = 0; i < 150; i++) {
    const g = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
    p *= 1 + g * 67e-6;
    out.push(p);
  }
  return out;
}

describe("grid bot", () => {
  it("picks its columns a few seconds before the lock", () => {
    const times = botPickTimes(seededRng(1));
    expect(times).toHaveLength(12);
    times.forEach((t, c) => {
      expect(t).toBeGreaterThanOrEqual(Math.max(0, columnStart(c) - 10 - 15));
      expect(t).toBeLessThanOrEqual(columnStart(c) - 10 - 2);
    });
  });

  it("always answers with a row", () => {
    const row = botRow([100, 100.1, 100.2, 100.1], 25, 100_00000000n, 2_500_000n, seededRng(2));
    expect(Number.isInteger(row)).toBe(true);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(row).toBeLessThanOrEqual(7);
  });

  it("hits roughly 35-50% of its columns on a random walk and is beatable", () => {
    const rng = seededRng(42);
    let hits = 0;
    let cols = 0;
    for (let g = 0; g < 400; g++) {
      const anchor = 100;
      const p = path(rng, anchor);
      const a = BigInt(Math.round(anchor * 1e8));
      const step = stepFor(a, STEP_PPM.SOL);
      let tr = newTrack();
      p.forEach((v, t) => (tr = record(tr, t, BigInt(Math.round(v * 1e8)))));
      tr = finish(tr);
      const at = botPickTimes(rng);
      const picks = at.map((when, c) => botRow(p.slice(0, Math.max(3, Math.floor(when) + 1)), columnStart(c) + 5 - when, a, step, rng));
      const r = settle(tr, [picks, Array(12).fill(NO_PICK)], a, step);
      hits += r.hits[0].filter(Boolean).length;
      cols += 12;
    }
    const rate = hits / cols;
    expect(rate).toBeGreaterThan(0.3);
    expect(rate).toBeLessThan(0.5);
  });
});
