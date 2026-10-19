import { describe, expect, it } from "vitest";
import { DAY_SECS, MONTH_SECS, awayNotice, awayView, breakEnd, breakOptions, confirmText, decodeAway, selfExclusionEnd, selfExclusionOptions } from "./protections";

const NOW = 1_800_000_000;

describe("decodeAway", () => {
  it("reads both end times after the entry limit", () => {
    const buf = new Uint8Array(145);
    const d = new DataView(buf.buffer);
    d.setBigInt64(81, 1_800_100_000n, true);
    d.setBigInt64(89, 1_815_000_000n, true);
    expect(decodeAway(buf)).toEqual({ breakUntil: 1_800_100_000, selfExclusionUntil: 1_815_000_000 });
  });
});

describe("awayView", () => {
  it("is free with no data or after the end", () => {
    expect(awayView(null, NOW).kind).toBeNull();
    expect(awayView({ breakUntil: NOW, selfExclusionUntil: 0 }, NOW).kind).toBeNull();
    expect(awayNotice(awayView(null, NOW))).toBeNull();
  });
  it("shows a Break, and a Self-Exclusion over it", () => {
    const b = awayView({ breakUntil: NOW + DAY_SECS, selfExclusionUntil: 0 }, NOW);
    expect([b.kind, b.until]).toEqual(["break", NOW + DAY_SECS]);
    expect(awayNotice(b)).toMatch(/^On a Break until /);
    const both = awayView({ breakUntil: NOW + DAY_SECS, selfExclusionUntil: NOW + 200 * DAY_SECS }, NOW);
    expect([both.kind, both.until]).toEqual(["self-exclusion", NOW + 200 * DAY_SECS]);
    expect(awayNotice(both)).toMatch(/^Self-Excluded until /);
  });
});

describe("ends and options", () => {
  it("counts a Self-Exclusion month as 30 days", () => {
    expect(selfExclusionEnd(NOW, 6)).toBe(NOW + 6 * MONTH_SECS);
    expect(breakEnd(NOW, 3)).toBe(NOW + 3 * DAY_SECS);
  });
  it("offers only choices that do not end the running one earlier", () => {
    const v = awayView({ breakUntil: NOW + 10 * DAY_SECS, selfExclusionUntil: NOW + 400 * DAY_SECS }, NOW);
    expect(breakOptions(v, NOW)).toEqual([14, 21, 28, 42]);
    expect(selfExclusionOptions(v, NOW)).toEqual([24, 36, 60]);
    expect(breakOptions(awayView(null, NOW), NOW)).toHaveLength(8);
  });
  it("says it cannot be undone and what still works", () => {
    const t = confirmText("self-exclusion", NOW + 180 * DAY_SECS);
    expect(t).toMatch(/cannot be undone/);
    expect(t).toMatch(/Advance/);
    expect(t).toMatch(/Redeem, Unlock and pay back what you owe/);
    expect(confirmText("break", NOW + DAY_SECS)).not.toMatch(/Advance/);
  });
});
