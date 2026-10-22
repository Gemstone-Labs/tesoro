import { describe, expect, it } from "vitest";
import { SETTLE_GRACE_SECS, delayedMatches, matchStanding, settleBy } from "./match-status";

const T = 1_000_000;
const bp = (over = {}) => ({ status: "active" as const, game: "block-puzzle" as const, deadline: T + 3600, ...over });
const duel = (joinedAt: number) => ({ status: "active" as const, game: "trading-duel" as const, deadline: joinedAt + 3600 });
const holdem = { status: "active" as const, game: "holdem" as const, deadline: T };

describe("matchStanding", () => {
  it("passes finished and open Matches through", () => {
    expect(matchStanding({ ...bp(), status: "open" }, T * 2).kind).toBe("open");
    expect(matchStanding({ ...bp(), status: "settled" }, T * 2).kind).toBe("settled");
    expect(matchStanding({ ...bp(), status: "refunded" }, T * 2).kind).toBe("refunded");
  });

  it("an unjoined Match is never Delayed, even a day into its 24 h Queue window", () => {
    const queued = { ...bp(), status: "open" as const, deadline: T + 24 * 3600 };
    expect(matchStanding(queued, T + 3601).kind).toBe("open");
    expect(matchStanding(queued, T + 24 * 3600 + 1).kind).toBe("open");
  });

  it("a Hold'em table is live for the 24 h its table window pushed the deadline to, not for the first hour", () => {
    const table = { ...holdem, deadline: T + 24 * 3600 };
    expect(matchStanding(table, T + 3601).kind).toBe("live");
    expect(matchStanding(table, T + 24 * 3600).kind).toBe("delayed");
  });

  it("Block Burst counts only the refund deadline: the table is assigned at a time the Match does not record", () => {
    expect(matchStanding(bp(), T + 3599).kind).toBe("live");
    expect(matchStanding(bp(), T + 3600)).toEqual({ kind: "delayed", refundBy: T + 3600, refundOpen: true });
  });

  it("opens the refund exactly at the core deadline", () => {
    const m = duel(T);
    const by = T + 450 + SETTLE_GRACE_SECS;
    expect(matchStanding(m, by)).toMatchObject({ kind: "delayed", refundOpen: false });
    expect(matchStanding(m, m.deadline)).toMatchObject({ kind: "delayed", refundOpen: true });
  });

  it("Trading Duel is late 450 s plus the grace after the join", () => {
    const m = duel(T);
    const by = T + 450 + SETTLE_GRACE_SECS;
    expect(settleBy(m)).toBe(by);
    expect(matchStanding(m, by - 1).kind).toBe("live");
    expect(matchStanding(m, by).kind).toBe("delayed");
  });

  it("Hold'em counts only the refund deadline", () => {
    expect(matchStanding(holdem, T - 1).kind).toBe("live");
    expect(matchStanding(holdem, T)).toEqual({ kind: "delayed", refundBy: T, refundOpen: true });
  });

  it("never settles later than the refund deadline", () => {
    const m = bp();
    expect(settleBy(m)).toBe(m.deadline);
  });

  it("is the same for the same state and clock, whoever asks", () => {
    expect(matchStanding(bp(), T + 1000)).toEqual(matchStanding({ ...bp() }, T + 1000));
  });
});

describe("Vanguard", () => {
  const DAY = 24 * 3600;
  /** create_match pushes the refund deadline to a full day after the Battle is created. */
  const vg = (createdAt: number) => ({ status: "active" as const, game: "vanguard" as const, deadline: createdAt + DAY });

  it("is late after the start window, the entropy window, the 15-minute cap and the grace, counted from create_match", () => {
    const m = vg(T);
    const by = T + 300 + 60 + 900 + SETTLE_GRACE_SECS;
    expect(settleBy(m)).toBe(by);
    expect(matchStanding(m, by - 1).kind).toBe("live");
    expect(matchStanding(m, by)).toEqual({ kind: "delayed", refundBy: T + DAY, refundOpen: false });
  });

  it("does not reuse Trading Duel's join-plus-an-hour assumption", () => {
    const m = vg(T);
    expect(matchStanding(m, T + 450 + SETTLE_GRACE_SECS).kind).toBe("live");
  });

  it("a Match whose Battle is not created yet (deadline still an hour after the join) is live, not Delayed", () => {
    const joined = { status: "active" as const, game: "vanguard" as const, deadline: T + 3600 };
    expect(matchStanding(joined, T + 20).kind).toBe("live");
    expect(matchStanding(joined, T + 3600)).toMatchObject({ kind: "delayed", refundOpen: true });
  });

  it("opens the refund at the core deadline", () => {
    expect(matchStanding(vg(T), T + DAY)).toMatchObject({ kind: "delayed", refundOpen: true });
  });
});

describe("delayedMatches", () => {
  it("keeps delayed Matches, soonest refund first", () => {
    const a = bp({ deadline: T + 4000 });
    const b = bp({ deadline: T + 3000 });
    const live = bp({ deadline: T + 9000 });
    expect(delayedMatches([a, live, b], T + 3500)).toEqual([b]);
    expect(delayedMatches([a, live, b], T + 4500)).toEqual([b, a]);
  });
});
