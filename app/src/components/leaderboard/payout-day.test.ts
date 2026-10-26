import { describe, expect, it } from "vitest";
import { fmtPayoutDay } from "./Leaderboard";

describe("fmtPayoutDay", () => {
  it("is short enough for a phone table cell and uses UTC", () => {
    expect(fmtPayoutDay(Date.UTC(2026, 9, 28, 0, 10) / 1000)).toBe("Oct 28");
  });
});
