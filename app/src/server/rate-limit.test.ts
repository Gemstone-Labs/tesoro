import { describe, expect, it } from "vitest";
import { WindowLimiter, takeAll } from "./rate-limit";

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

describe("takeAll (ST-01)", () => {
  const three = () => [new WindowLimiter(3, 1000), new WindowLimiter(3, 1000), new WindowLimiter(3, 1000)];

  it.each([0, 1, 2])("a rejection by limiter %i leaves every counter as it was", (full) => {
    const ls = three();
    ls.forEach((l, i) => l.take("k", i === full ? 3 : 1));
    expect(takeAll(ls.map((l) => [l, "k"] as const))).toBeNull();
    ls.forEach((l, i) => {
      if (i === full) expect(l.take("k")).toBe(false);
      else expect([l.take("k", 2), l.take("k")]).toEqual([true, false]);
    });
  });

  it("the returned refund gives back exactly what was taken", () => {
    const ls = three();
    takeAll(ls.map((l) => [l, "k"] as const), 2)!();
    ls.forEach((l) => expect(l.take("k", 3)).toBe(true));
  });

  it("alternating rejected and accepted requests cannot exceed the caps", () => {
    const perId = new WindowLimiter(20, 1000);
    const global = new WindowLimiter(300, 1000);
    let granted = 0;
    for (let i = 0; i < 110; i++) if (takeAll([[perId, "evm"], [global, "all"]], 6)) granted += 6;
    expect(granted).toBe(18);
  });
});
