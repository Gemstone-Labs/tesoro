import { describe, expect, it } from "vitest";
import { WindowLimiter } from "./rate-limit";

describe("WindowLimiter", () => {
  it("allows up to max per window, then resets", () => {
    const l = new WindowLimiter(2, 1000);
    expect(l.take("a", 1, 0)).toBe(true);
    expect(l.take("a", 1, 10)).toBe(true);
    expect(l.take("a", 1, 20)).toBe(false);
    expect(l.take("b", 1, 20)).toBe(true);
    expect(l.take("a", 1, 1000)).toBe(true);
  });

  it("supports costs and refunds", () => {
    const l = new WindowLimiter(10, 1000);
    expect(l.take("a", 7, 0)).toBe(true);
    expect(l.take("a", 4, 1)).toBe(false);
    l.refund("a", 7);
    expect(l.take("a", 10, 2)).toBe(true);
    expect(l.take("a", 11, 5000)).toBe(false);
  });
});
