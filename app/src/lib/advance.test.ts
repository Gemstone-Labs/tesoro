import { describe, expect, it } from "vitest";
import { DEFAULT_HORIZON_MONTHS } from "./advance";

describe("DEFAULT_HORIZON_MONTHS", () => {
  it("starts every form at 1 month", () => {
    expect(DEFAULT_HORIZON_MONTHS).toBe(1);
  });
});
