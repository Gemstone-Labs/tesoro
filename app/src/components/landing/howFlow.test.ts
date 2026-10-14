import { describe, expect, it } from "vitest";
import { howFlow, STOPS, TUBE_COUNT } from "./howFlow";

describe("howFlow", () => {
  it("starts with only the Position lit and no tube drawn", () => {
    const f = howFlow(0);
    expect(f.nodes.position).toBe(1);
    for (const s of STOPS.filter((s) => s !== "position")) expect(f.nodes[s]).toBe(0);
    expect(f.tubes).toEqual(new Array(TUBE_COUNT).fill(0));
  });

  it("ends with every stop at full strength, the closing line included, and every tube drawn", () => {
    const f = howFlow(1);
    for (const s of STOPS) expect(f.nodes[s]).toBe(1);
    expect(f.tubes).toEqual(new Array(TUBE_COUNT).fill(1));
  });

  it("only ever adds to what is lit as progress grows", () => {
    let prev = howFlow(0);
    for (let i = 1; i <= 200; i++) {
      const f = howFlow(i / 200);
      f.tubes.forEach((t, k) => expect(t).toBeGreaterThanOrEqual(prev.tubes[k]));
      for (const s of STOPS) expect(f.nodes[s]).toBeGreaterThanOrEqual(prev.nodes[s]);
      prev = f;
    }
  });

  it("lights the stops in flow order, the closing line last", () => {
    const first = (s: (typeof STOPS)[number]) => {
      for (let i = 0; i <= 1000; i++) if (howFlow(i / 1000).nodes[s] > 0) return i;
      return Infinity;
    };
    expect(first("advance")).toBeLessThan(first("play"));
    expect(first("play")).toBeLessThan(first("settle"));
    expect(first("settle")).toBeLessThan(first("win"));
    expect(first("win")).toBeLessThan(first("foot"));
    expect(first("play")).toBe(first("back"));
    expect(first("win")).toBe(first("lose"));
  });

  it("clamps out-of-range progress", () => {
    expect(howFlow(-1)).toEqual(howFlow(0));
    expect(howFlow(2)).toEqual(howFlow(1));
  });
});
