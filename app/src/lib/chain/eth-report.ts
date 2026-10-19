import type { BridgePositionView } from "./eth";

/**
 * Solana learns an ETH or HYPE Position's Accrued Yield only from a Yield Report (ADR 0010). These are the pure decisions
 * around asking for one when a Player's action needs it; the flow that acts on them is `freshenYield` in eth-flow.ts.
 */
export type ReportAction = "unlock" | "redeem" | "instant";

/** A report asked for in the last few minutes is waited for, not asked for again. */
export const REPORT_REUSE_MS = 3 * 60_000;
/** Give up waiting for a report to be applied after this long (it still lands; clicking again carries on). */
export const REPORT_WAIT_MS = 5 * 60_000;
export const REPORT_POLL_MS = 4000;

export type ReportPlan =
  | { kind: "none" }
  /** A report arrived on Solana but is not applied yet: apply it, then wait. */
  | { kind: "apply" }
  | { kind: "request" }
  /** One was asked for already (`baseline` = the bridge's last received seq at that moment): wait for it. */
  | { kind: "wait"; baseline: bigint };

export interface ReportInput {
  action: ReportAction;
  bridge: Pick<BridgePositionView, "yieldCumulative" | "lastYieldSeq" | "appliedYieldSeq"> | null;
  /** The vault's Accrued Yield now (`fetchVaultPosition(...).accrued`). */
  liveAccrued: bigint;
  /** Unlock: the Debt in Gemas Solana has, and the Debt if the live figure were applied. */
  onChainDebt: bigint;
  projectedDebt: bigint;
  /** Redeem, Instant Redeem: this Position's Gemas still waiting on yield. */
  waitingGemas: bigint;
  /** The newest report this browser asked for on this Position, if any. */
  recent: { baseline: bigint; at: number } | null;
  now: number;
}

/** Does the action gain from a fresh report, and if so what is the next step. */
export function planReport(i: ReportInput): ReportPlan {
  if (!i.bridge) return { kind: "none" };
  const needs = i.action === "unlock" ? i.onChainDebt > 0n && i.projectedDebt === 0n : i.waitingGemas > 0n && i.liveAccrued > i.bridge.yieldCumulative;
  if (!needs) return { kind: "none" };
  if (i.bridge.lastYieldSeq > i.bridge.appliedYieldSeq) return { kind: "apply" };
  if (i.recent && i.now - i.recent.at < REPORT_REUSE_MS) {
    // Asked a moment ago: wait for it if it has not been applied; if it was, the live figure only drifts on from it.
    return i.bridge.appliedYieldSeq > i.recent.baseline ? { kind: "none" } : { kind: "wait", baseline: i.recent.baseline };
  }
  return { kind: "request" };
}

/** A report newer than `baseline` has been received and applied on Solana. */
export const reportApplied = (bridge: Pick<BridgePositionView, "lastYieldSeq" | "appliedYieldSeq"> | null, baseline: bigint) =>
  !!bridge && bridge.lastYieldSeq > baseline && bridge.appliedYieldSeq >= bridge.lastYieldSeq;
