import { describe, expect, it } from "vitest";
import { REPORT_REUSE_MS, planReport, reportApplied, type ReportInput } from "./eth-report";

const bridge = (over: Partial<NonNullable<ReportInput["bridge"]>> = {}) => ({ yieldCumulative: 100n, lastYieldSeq: 3n, appliedYieldSeq: 3n, ...over });
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  action: "unlock",
  bridge: bridge(),
  liveAccrued: 500n,
  onChainDebt: 10n,
  projectedDebt: 0n,
  waitingGemas: 0n,
  recent: null,
  now: 1_000_000,
  ...over,
});

describe("planReport: Unlock", () => {
  it("asks for a report when the vault covers a Debt Solana still shows", () => {
    expect(planReport(base())).toEqual({ kind: "request" });
  });
  it("needs nothing when Debt is already 0 on Solana", () => {
    expect(planReport(base({ onChainDebt: 0n }))).toEqual({ kind: "none" });
  });
  it("needs nothing when the live figure does not cover the Debt either", () => {
    expect(planReport(base({ projectedDebt: 4n }))).toEqual({ kind: "none" });
  });
  it("needs nothing without a bridge record", () => {
    expect(planReport(base({ bridge: null }))).toEqual({ kind: "none" });
  });
});

describe("planReport: Redeem and Instant Redeem", () => {
  const redeem = (over: Partial<ReportInput> = {}) => base({ action: "redeem", onChainDebt: 0n, waitingGemas: 7n, ...over });
  it("asks when Gemas wait on yield and the vault is ahead of Solana", () => {
    expect(planReport(redeem())).toEqual({ kind: "request" });
    expect(planReport(redeem({ action: "instant" }))).toEqual({ kind: "request" });
  });
  it("needs nothing when no Gemas wait or the vault is not ahead", () => {
    expect(planReport(redeem({ waitingGemas: 0n }))).toEqual({ kind: "none" });
    expect(planReport(redeem({ liveAccrued: 100n }))).toEqual({ kind: "none" });
  });
});

describe("planReport: a report already asked for or arrived", () => {
  it("applies an arrived report before anything else, for every action", () => {
    const arrived = bridge({ lastYieldSeq: 4n });
    expect(planReport(base({ bridge: arrived }))).toEqual({ kind: "apply" });
    expect(planReport(base({ bridge: arrived, action: "redeem", onChainDebt: 0n, waitingGemas: 0n, liveAccrued: 0n }))).toEqual({ kind: "apply" });
    expect(planReport(base({ bridge: arrived, action: "instant", onChainDebt: 0n, waitingGemas: 0n }))).toEqual({ kind: "apply" });
    expect(planReport(base({ bridge: arrived, onChainDebt: 0n }))).toEqual({ kind: "apply" });
  });
  it("waits for one asked a moment ago that is not applied yet", () => {
    expect(planReport(base({ recent: { baseline: 3n, at: 1_000_000 - 10_000 } }))).toEqual({ kind: "wait", baseline: 3n });
  });
  it("asks for a new one when the recent report was applied and the action still gains", () => {
    const applied = bridge({ lastYieldSeq: 4n, appliedYieldSeq: 4n });
    expect(planReport(base({ bridge: applied, recent: { baseline: 3n, at: 1_000_000 - 10_000 } }))).toEqual({ kind: "request" });
    expect(planReport(base({ action: "redeem", waitingGemas: 7n, bridge: applied, recent: { baseline: 3n, at: 1_000_000 - 10_000 } }))).toEqual({ kind: "request" });
  });
  it("needs nothing once a recent applied report left nothing to gain", () => {
    expect(planReport(base({ bridge: bridge({ lastYieldSeq: 4n, appliedYieldSeq: 4n }), onChainDebt: 0n, recent: { baseline: 3n, at: 1_000_000 - 10_000 } }))).toEqual({ kind: "none" });
  });
  it("asks again once the earlier one is old", () => {
    expect(planReport(base({ recent: { baseline: 3n, at: 1_000_000 - REPORT_REUSE_MS - 1 } }))).toEqual({ kind: "request" });
  });
});

describe("planReport: Instant Redeem with a stale Treasury mirror", () => {
  it("asks for a report when the vault holds more than the mirror shows, even with no new yield", () => {
    expect(planReport(base({ action: "instant", onChainDebt: 0n, waitingGemas: 7n, liveAccrued: 100n, treasuryBehind: true }))).toEqual({ kind: "request" });
    expect(planReport(base({ action: "instant", onChainDebt: 0n, waitingGemas: 7n, liveAccrued: 100n }))).toEqual({ kind: "none" });
  });
});

describe("reportApplied", () => {
  it("is true only when a report newer than the baseline is received and applied", () => {
    expect(reportApplied({ lastYieldSeq: 3n, appliedYieldSeq: 3n }, 3n)).toBe(false);
    expect(reportApplied({ lastYieldSeq: 4n, appliedYieldSeq: 3n }, 3n)).toBe(false);
    expect(reportApplied({ lastYieldSeq: 4n, appliedYieldSeq: 4n }, 3n)).toBe(true);
    expect(reportApplied(null, 0n)).toBe(false);
  });
});
