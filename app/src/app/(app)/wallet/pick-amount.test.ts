import { describe, expect, it } from "vitest";
import { allocate, clampPick, scaled } from "./pick-amount";

describe("allocate", () => {
  const lines = [{ gemas: 500 }, { gemas: 300 }, { gemas: 200 }];
  it("takes whole lines first, in listed order, and a part of the last one", () => {
    expect(allocate(lines, 650)).toEqual([500, 150, 0]);
  });
  it("takes everything for the full total", () => {
    expect(allocate(lines, 1000)).toEqual([500, 300, 200]);
  });
  it("never takes more than a line has, and ignores totals past the sum", () => {
    expect(allocate(lines, 5000)).toEqual([500, 300, 200]);
  });
  it("takes nothing for zero, negative or non-finite totals", () => {
    expect(allocate(lines, 0)).toEqual([0, 0, 0]);
    expect(allocate(lines, -3)).toEqual([0, 0, 0]);
    expect(allocate(lines, Number.NaN)).toEqual([0, 0, 0]);
  });
  it("floors a fractional total", () => {
    expect(allocate(lines, 10.9)).toEqual([10, 0, 0]);
  });
});

describe("clampPick", () => {
  it("keeps the pick between 0 and the most there is", () => {
    expect(clampPick(50, 100)).toBe(50);
    expect(clampPick(500, 100)).toBe(100);
    expect(clampPick(-5, 100)).toBe(0);
    expect(clampPick(Number.NaN, 100)).toBe(0);
  });
});

describe("scaled", () => {
  it("scales a line's payout to the part taken", () => {
    expect(scaled(2, 500, 250)).toBe(1);
    expect(scaled(2, 500, 500)).toBe(2);
    expect(scaled(null, 500, 250)).toBeNull();
    expect(scaled(2, 0, 0)).toBe(0);
  });
});
