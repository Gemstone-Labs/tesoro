import { describe, expect, it } from "vitest";
import { SETTLE_GRACE_SECS, delayedMatches, matchStanding, settleBy } from "./match-status";

const T = 1_000_000;
const session = (deadline: number, openerDeadline = deadline) => ({ settled: false, joined: true, result: "draw" as const, scores: [0, 0] as [number, number], seed: 0n, openerDeadline, deadline });
const bp = (over = {}) => ({ status: "active" as const, game: "block-puzzle" as const, deadline: T + 3600, session: session(T), ...over });
const duel = (joinedAt: number) => ({ status: "active" as const, game: "trading-duel" as const, deadline: joinedAt + 3600, session: null });
const holdem = { status: "active" as const, game: "holdem" as const, deadline: T, session: null };

describe("matchStanding", () => {
  it("passes finished and open Matches through", () => {
    expect(matchStanding({ ...bp(), status: "open" }, T * 2).kind).toBe("open");
    expect(matchStanding({ ...bp(), status: "settled" }, T * 2).kind).toBe("settled");
    expect(matchStanding({ ...bp(), status: "refunded" }, T * 2).kind).toBe("refunded");
  });

  it("Block Puzzle is live until the later submission deadline plus the grace, then delayed", () => {
    const by = T + SETTLE_GRACE_SECS;
    expect(matchStanding(bp(), by - 1).kind).toBe("live");
    expect(matchStanding(bp(), by)).toEqual({ kind: "delayed", refundBy: T + 3600, refundOpen: false });
  });

  it("uses the opener's deadline when it is later than the joiner's", () => {
    const m = bp({ session: session(T, T + 500) });
    expect(matchStanding(m, T + 500 + SETTLE_GRACE_SECS - 1).kind).toBe("live");
    expect(matchStanding(m, T + 500 + SETTLE_GRACE_SECS).kind).toBe("delayed");
  });

  it("opens the refund exactly at the core deadline", () => {
    const m = bp();
    expect(matchStanding(m, m.deadline - 1)).toMatchObject({ kind: "delayed", refundOpen: false });
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
    const m = bp({ session: session(T + 99_999) });
    expect(settleBy(m)).toBe(m.deadline);
  });

  it("is the same for the same state and clock, whoever asks", () => {
    expect(matchStanding(bp(), T + 1000)).toEqual(matchStanding({ ...bp() }, T + 1000));
  });
});

describe("delayedMatches", () => {
  it("keeps delayed Matches, soonest refund first", () => {
    const a = bp({ deadline: T + 4000 });
    const b = bp({ deadline: T + 3000 });
    const live = bp({ session: session(T + 3000) });
    expect(delayedMatches([a, live, b], T + 1000)).toEqual([b, a]);
  });
});
