import { describe, expect, it } from "vitest";
import { fmtGemasUsd } from "./format";

describe("fmtGemasUsd", () => {
  it("shows whole dollars without cents", () => {
    expect(fmtGemasUsd(1900)).toBe("≈ $19");
    expect(fmtGemasUsd(100)).toBe("≈ $1");
  });
  it("keeps cents when the value has them", () => {
    expect(fmtGemasUsd(450)).toBe("≈ $4.50");
    expect(fmtGemasUsd(5)).toBe("≈ $0.05");
  });
  it("groups thousands and drops cents from $100", () => {
    expect(fmtGemasUsd(150000)).toBe("≈ $1,500");
    expect(fmtGemasUsd(12345)).toBe("≈ $123");
  });
  it("handles zero", () => {
    expect(fmtGemasUsd(0)).toBe("≈ $0");
  });
});
