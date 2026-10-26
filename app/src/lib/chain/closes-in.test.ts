import { describe, expect, it } from "vitest";
import { closesIn } from "./useBackingBoard";

describe("closesIn", () => {
  const now = 1_000_000_000_000;
  const at = (secs: number) => now / 1000 + secs;
  it("names whole days when a day or more is left", () => {
    expect(closesIn(at(2 * 86400 + 3600), now)).toBe("2d left");
  });
  it("names whole hours when an hour or more is left", () => {
    expect(closesIn(at(23 * 3600 + 59 * 60), now)).toBe("23h left");
  });
  it("names minutes under an hour, never 0m", () => {
    expect(closesIn(at(12 * 60 + 30), now)).toBe("12m left");
    expect(closesIn(at(20), now)).toBe("1m left");
  });
  it("says Closed once the time is up", () => {
    expect(closesIn(at(0), now)).toBe("Closed");
  });
});
