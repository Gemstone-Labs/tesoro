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
  /** Instant Redeem: the bridge's mirror of the vault Treasury is below what the vault itself holds now, and a report refreshes it. */
  treasuryBehind?: boolean;
  /** The newest report this browser asked for on this Position, if any. */
  recent: { baseline: bigint; at: number } | null;
  now: number;
}

/** Does the action gain from a fresh report, and if so what is the next step. */
export function planReport(i: ReportInput): ReportPlan {
  if (!i.bridge) return { kind: "none" };
  // A report that already arrived is applied whatever the action: it is paid for and only needs this step.
  if (i.bridge.lastYieldSeq > i.bridge.appliedYieldSeq) return { kind: "apply" };
  const needs =
    i.treasuryBehind === true ||
    (i.action === "unlock" ? i.onChainDebt > 0n && i.projectedDebt === 0n : i.waitingGemas > 0n && i.liveAccrued > i.bridge.yieldCumulative);
  if (!needs) return { kind: "none" };
  if (i.recent && i.now - i.recent.at < REPORT_REUSE_MS && i.bridge.appliedYieldSeq <= i.recent.baseline) {
    // Asked a moment ago and not applied yet: wait for that one.
    return { kind: "wait", baseline: i.recent.baseline };
  }
  // Nothing in flight: ask. If an earlier one was applied and the live figure moved on, this is a new report (the server's
  // cooldown still applies; a refusal there turns into a wait).
  return { kind: "request" };
}

/** A report newer than `baseline` has been received and applied on Solana. */
export const reportApplied = (bridge: Pick<BridgePositionView, "lastYieldSeq" | "appliedYieldSeq"> | null, baseline: bigint) =>
  !!bridge && bridge.lastYieldSeq > baseline && bridge.appliedYieldSeq >= bridge.lastYieldSeq;
