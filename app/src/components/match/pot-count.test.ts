import { describe, expect, it } from "vitest";
import { markPotCounted, potCountFrom } from "./pot-count";

describe("Pot count-up", () => {
  it("starts at 0 for a Match it has not played for, then at the full Pot at every later stage", () => {
    expect(potCountFrom("match-a", 940)).toBe(0);
    markPotCounted("match-a");
    expect(potCountFrom("match-a", 940)).toBe(940);
    expect(potCountFrom("match-b", 940)).toBe(0);
  });

  it("counts up each time when it does not know the Match", () => {
    markPotCounted(undefined);
    expect(potCountFrom(undefined, 940)).toBe(0);
  });
});
