import { describe, expect, it } from "vitest";
import { urgencyFor } from "./feedback";

describe("prototype board urgency", () => {
  it("starts the board cue at ten seconds and strengthens it at five", () => {
    expect(urgencyFor(90, true, false)).toBe("none");
    expect(urgencyFor(11, true, false)).toBe("none");
    expect(urgencyFor(10.01, true, false)).toBe("none");
    expect(urgencyFor(10, true, false)).toBe("low");
    expect(urgencyFor(5.01, true, false)).toBe("low");
    expect(urgencyFor(5, true, false)).toBe("critical");
    expect(urgencyFor(1, true, false)).toBe("critical");
  });

  it("clears the cue at expiry and before the next fixture starts", () => {
    expect(urgencyFor(0, true, false)).toBe("none");
    expect(urgencyFor(-1, true, true)).toBe("none");
    expect(urgencyFor(1, true, true)).toBe("none");
    expect(urgencyFor(5, false, false)).toBe("none");
    expect(urgencyFor(90, false, false)).toBe("none");
    expect(urgencyFor(Number.NaN, true, false)).toBe("none");
  });
});
