import { describe, expect, it } from "vitest";
import { closesIn } from "./useBackingBoard";

describe("closesIn", () => {
  const now = 1_000_000_000_000;
  const at = (secs: number) => now / 1000 + secs;
  it("names whole hours when an hour or more is left", () => {
    expect(closesIn(at(23 * 3600 + 59 * 60), now)).toBe("Closes in 23h");
  });
  it("names minutes under an hour, never 0m", () => {
    expect(closesIn(at(12 * 60 + 30), now)).toBe("Closes in 12m");
    expect(closesIn(at(20), now)).toBe("Closes in 1m");
  });
  it("says Closed once the time is up", () => {
    expect(closesIn(at(0), now)).toBe("Closed");
  });
});
