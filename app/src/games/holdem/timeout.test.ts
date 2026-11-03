import { describe, expect, it } from "vitest";
import { CLAIM_MARGIN_MS, CLAIM_RETRY_MS, timeoutClaimDue } from "./timeout";
import { PHASE, STATUS } from "./chain";

const live = (over: Partial<{ status: number; phase: number; toAct: number; deadline: number }> = {}) => ({
  status: STATUS.live,
  phase: PHASE.flop,
  toAct: 1,
  deadline: 1_000,
  ...over,
});
const at = (deadlineS: number, afterMs: number) => deadlineS * 1000 + afterMs;

describe("timeoutClaimDue", () => {
  it("waits for the margin past the deadline, then claims when the opponent is to act", () => {
    expect(timeoutClaimDue(live(), 0, at(1_000, CLAIM_MARGIN_MS - 1), 0)).toBe(false);
    expect(timeoutClaimDue(live(), 0, at(1_000, CLAIM_MARGIN_MS), 0)).toBe(true);
  });
  it("never claims against myself", () => {
    expect(timeoutClaimDue(live({ toAct: 0 }), 0, at(1_000, 60_000), 0)).toBe(false);
  });
  it("claims a stalled shuffle for either seat", () => {
    expect(timeoutClaimDue(live({ phase: PHASE.shuffle, toAct: 0 }), 0, at(1_000, 60_000), 0)).toBe(true);
    expect(timeoutClaimDue(live({ phase: PHASE.shuffle, toAct: 1 }), 0, at(1_000, 60_000), 0)).toBe(true);
  });
  it("does not send twice inside the retry gap, and retries after it", () => {
    const t = at(1_000, 10_000);
    expect(timeoutClaimDue(live(), 0, t, t - 1_500)).toBe(false);
    expect(timeoutClaimDue(live(), 0, t, t - CLAIM_RETRY_MS)).toBe(true);
  });
  it("does nothing when the opponent acted (new deadline) or the table is not live", () => {
    expect(timeoutClaimDue(live({ deadline: 1_100 }), 0, at(1_000, 10_000), 0)).toBe(false);
    expect(timeoutClaimDue(live({ status: STATUS.over }), 0, at(1_000, 60_000), 0)).toBe(false);
    expect(timeoutClaimDue(live({ phase: PHASE.none }), 0, at(1_000, 60_000), 0)).toBe(false);
  });
});
