import { describe, expect, it } from "vitest";
import { DEFAULT_EXTEND_LIMIT, blockedLabel, decodeExtendLimit, extendLimitChange, extendLimitView, type ExtendLimitData } from "./extend-limit";

const DAY = 86_400;
const NOW = 1_800_000_000;
const fresh: ExtendLimitData = { months: 3, pendingMonths: 0, pendingAt: 0, windowStart: 0, windowMonths: 0, lastExtendAt: 0 };
const view = (l: Partial<ExtendLimitData>, horizon = 3, now = NOW) => extendLimitView({ ...fresh, ...l }, now, horizon);

describe("extendLimitView", () => {
  it("default: 3 months, none used, nothing to wait for", () => {
    const v = view({});
    expect(v).toMatchObject({ limit: 3, used: 0, remaining: 3, resetsAt: null, nextExtendAt: null, maxMonths: 3, blocked: null, committed: 3 });
  });

  it("absent account reads as the default", () => {
    expect(extendLimitView(null, NOW, 3).limit).toBe(DEFAULT_EXTEND_LIMIT);
  });

  it("waiting: inside 24 h of the last Extend, until that time", () => {
    const v = view({ windowStart: NOW - 100, windowMonths: 1, lastExtendAt: NOW - 100 });
    expect(v.blocked).toEqual({ kind: "waiting", until: NOW - 100 + DAY });
    expect(v.nextExtendAt).toBe(NOW - 100 + DAY);
    expect(v.used).toBe(1);
    expect(v.remaining).toBe(2);
  });

  it("the wait ends exactly 24 h later", () => {
    expect(view({ windowStart: NOW - DAY, windowMonths: 1, lastExtendAt: NOW - DAY }).blocked).toBeNull();
    expect(view({ windowStart: NOW - DAY + 1, windowMonths: 1, lastExtendAt: NOW - DAY + 1 }).blocked?.kind).toBe("waiting");
  });

  it("at the limit: blocked until the period resets", () => {
    const start = NOW - 5 * DAY;
    const v = view({ windowStart: start, windowMonths: 3, lastExtendAt: start });
    expect(v.blocked).toEqual({ kind: "limit", until: start + 30 * DAY });
    expect(v.remaining).toBe(0);
    expect(v.maxMonths).toBe(0);
    expect(v.resetsAt).toBe(start + 30 * DAY);
  });

  it("a finished period counts as unused", () => {
    const start = NOW - 30 * DAY;
    const v = view({ windowStart: start, windowMonths: 3, lastExtendAt: start });
    expect(v).toMatchObject({ used: 0, remaining: 3, resetsAt: null, blocked: null });
  });

  it("a due pending raise counts; a future one is shown with its time", () => {
    expect(view({ pendingMonths: 6, pendingAt: NOW - 1 })).toMatchObject({ limit: 6, pending: null, maxMonths: 6 });
    const v = view({ pendingMonths: 6, pendingAt: NOW + 3600 });
    expect(v.limit).toBe(3);
    expect(v.pending).toEqual({ months: 6, at: NOW + 3600 });
  });

  it("limit 0: Extend is off", () => {
    const v = view({ months: 0 });
    expect(v.blocked).toEqual({ kind: "off" });
    expect(v.maxMonths).toBe(0);
  });

  it("the 12-month cap can be tighter than the limit", () => {
    const v = view({ months: 11 }, 11);
    expect(v.maxMonths).toBe(1);
    expect(view({ months: 11 }, 12)).toMatchObject({ maxMonths: 0, blocked: { kind: "full" } });
  });

  it("a limit lowered under what is used leaves nothing", () => {
    const start = NOW - DAY * 2;
    const v = view({ months: 1, windowStart: start, windowMonths: 3, lastExtendAt: start });
    expect(v.remaining).toBe(0);
    expect(v.blocked).toEqual({ kind: "limit", until: start + 30 * DAY });
  });

  it("waiting wins over the limit, as the program checks it first", () => {
    const v = view({ windowStart: NOW - 10, windowMonths: 3, lastExtendAt: NOW - 10 });
    expect(v.blocked?.kind).toBe("waiting");
  });
});

describe("decodeExtendLimit", () => {
  it("reads the account bytes (disc 8, bump 1, account 32, then the limit)", () => {
    const buf = new Uint8Array(8 + 1 + 32 + 27);
    const d = new DataView(buf.buffer);
    let o = 41;
    buf[o++] = 5;
    buf[o++] = 8;
    d.setBigInt64(o, 1234n, true); o += 8;
    d.setBigInt64(o, 99n, true); o += 8;
    buf[o++] = 2;
    d.setBigInt64(o, 77n, true);
    expect(decodeExtendLimit(buf)).toEqual({ months: 5, pendingMonths: 8, pendingAt: 1234, windowStart: 99, windowMonths: 2, lastExtendAt: 77 });
  });
});

describe("an unread limit", () => {
  it("is unknown, not the default: Extend is blocked until it reads", () => {
    const v = extendLimitView("unknown", NOW, 3);
    expect(v.blocked).toEqual({ kind: "unknown" });
    expect(v.maxMonths).toBe(0);
  });
});

describe("extendLimitChange", () => {
  const v = (l: Partial<ExtendLimitData>) => extendLimitView({ ...fresh, ...l }, NOW, 3);
  it("lowers at once, raises later", () => {
    expect(extendLimitChange(v({}), 1)).toBe("lower");
    expect(extendLimitChange(v({}), 5)).toBe("raise");
  });
  it("the value in force with no raise pending changes nothing", () => {
    expect(extendLimitChange(v({}), 3)).toBe("same");
  });
  it("the pending value again changes nothing; the value in force cancels the raise", () => {
    const pending = v({ pendingMonths: 6, pendingAt: NOW + 3600 });
    expect(extendLimitChange(pending, 6)).toBe("same");
    expect(extendLimitChange(pending, 3)).toBe("cancel");
    expect(extendLimitChange(pending, 2)).toBe("lower");
    expect(extendLimitChange(pending, 8)).toBe("raise");
  });
});

describe("blockedLabel", () => {
  it("stays short enough for one line at 390 px", () => {
    for (const b of [{ kind: "waiting", until: NOW }, { kind: "limit", until: NOW }, { kind: "off" }, { kind: "full" }, { kind: "unknown" }] as const) {
      expect(blockedLabel(b).length).toBeLessThanOrEqual(26);
    }
    expect(blockedLabel({ kind: "waiting", until: NOW })).toMatch(/^Wait until /);
    expect(blockedLabel({ kind: "off" })).toBe("Extend is off");
    expect(blockedLabel({ kind: "limit", until: NOW })).toBe("Limit reached");
  });
});
