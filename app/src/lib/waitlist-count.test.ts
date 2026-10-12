import { describe, expect, it } from "vitest";
import { waitingLabel } from "./waitlist-count";

describe("waitingLabel", () => {
  it("hides the count below the threshold or when storage is down", () => {
    expect(waitingLabel(null)).toBeNull();
    expect(waitingLabel(1)).toBeNull();
    expect(waitingLabel(99)).toBeNull();
  });

  it("rounds down so the figure never overstates", () => {
    expect(waitingLabel(100)).toBe("100+ players waiting");
    expect(waitingLabel(250)).toBe("200+ players waiting");
    expect(waitingLabel(1_299)).toBe("1,200+ players waiting");
    expect(waitingLabel(12_750)).toBe("12,000+ players waiting");
  });
});
