import { describe, expect, it } from "vitest";
import { ENTRY_PERIOD_SECS, decodeEntryLimit, entryLimitChange, entryLimitOptions, entryLimitView, type EntryLimitData } from "./entry-limit";

const DAY = 86_400;
const NOW = 1_800_000_000;
const none: EntryLimitData = { gemas: 0, pendingGemas: 0, pendingAt: 0, windowStart: 0, windowUsed: 0 };
const view = (l: Partial<EntryLimitData>, now = NOW) => entryLimitView({ ...none, ...l }, now);

describe("entryLimitView", () => {
  it("no account: no limit", () => {
    expect(entryLimitView(null, NOW)).toEqual({ limit: null, pending: null, used: 0, remaining: null, resetsAt: null });
  });

  it("counts what is left and when the period resets", () => {
    const v = view({ gemas: 1_500, windowStart: NOW - DAY, windowUsed: 1_000 });
    expect(v).toMatchObject({ limit: 1_500, used: 1_000, remaining: 500, resetsAt: NOW - DAY + ENTRY_PERIOD_SECS });
  });

  it("a period that ended counts as unused, exactly 7 days after it began", () => {
    const start = NOW - ENTRY_PERIOD_SECS;
    expect(view({ gemas: 1_000, windowStart: start + 1, windowUsed: 1_000 }).remaining).toBe(0);
    expect(view({ gemas: 1_000, windowStart: start, windowUsed: 1_000 })).toMatchObject({ used: 0, remaining: 1_000, resetsAt: null });
  });

  it("a raise waits for its time, then is the limit", () => {
    const l = { gemas: 500, pendingGemas: 2_500, pendingAt: NOW + 100 };
    expect(view(l).limit).toBe(500);
    expect(view(l).pending).toEqual({ gemas: 2_500, at: NOW + 100 });
    expect(view(l, NOW + 100)).toMatchObject({ limit: 2_500, pending: null });
  });

  it("removing the limit is a pending raise to none", () => {
    const l = { gemas: 500, pendingGemas: 0, pendingAt: NOW + 100 };
    expect(view(l).pending).toEqual({ gemas: null, at: NOW + 100 });
    expect(view(l, NOW + 100)).toMatchObject({ limit: null, remaining: null });
  });
});

describe("entryLimitChange", () => {
  const v = view({ gemas: 1_000 });
  it("same, lower, raise, and none counts as the highest", () => {
    expect(entryLimitChange(v, 1_000)).toBe("same");
    expect(entryLimitChange(v, 500)).toBe("lower");
    expect(entryLimitChange(v, 2_500)).toBe("raise");
    expect(entryLimitChange(v, 0)).toBe("raise");
    expect(entryLimitChange(view({}), 500)).toBe("lower");
    expect(entryLimitChange(view({}), 0)).toBe("same");
  });
  it("the value in force cancels a pending raise; the pending value changes nothing", () => {
    const p = view({ gemas: 1_000, pendingGemas: 2_500, pendingAt: NOW + 10 });
    expect(entryLimitChange(p, 1_000)).toBe("cancel");
    expect(entryLimitChange(p, 2_500)).toBe("same");
    expect(entryLimitChange(p, 500)).toBe("lower");
  });
});

describe("entryLimitOptions", () => {
  it("adds a limit that is not one of the standard choices, sorted, none first", () => {
    expect(entryLimitOptions(view({ gemas: 700 }))).toEqual([0, 500, 700, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000]);
  });
});

describe("decodeEntryLimit", () => {
  it("reads the fields at their offsets after the 41-byte header", () => {
    const buf = new Uint8Array(145);
    const d = new DataView(buf.buffer);
    d.setBigUint64(41, 1_500n, true);
    d.setBigUint64(49, 2_500n, true);
    d.setBigInt64(57, 1_800_000_100n, true);
    d.setBigInt64(65, 1_800_000_000n, true);
    d.setBigUint64(73, 500n, true);
    expect(decodeEntryLimit(buf)).toEqual({ gemas: 1_500, pendingGemas: 2_500, pendingAt: 1_800_000_100, windowStart: 1_800_000_000, windowUsed: 500 });
  });
});
