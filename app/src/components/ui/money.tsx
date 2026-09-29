import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import type { Chain } from "@/lib/mock/types";
import { GemaAmount, SimulatedYieldLabel } from "./gema";
import { CheckIcon, ClockIcon, MinusIcon, XIcon } from "./icons";
import { ChainChip, Label, Meter } from "./primitives";

/** The balance: big, plain, emerald-cut. The only place the glint runs. */
export function BalanceCard({ total, title = "Your Gemas" }: { total: number; title?: string }) {
  return (
    <section className="cut cut-card balance" aria-label={title}>
      <Label>{title}</Label>
      <GemaAmount value={total} size="xl" glint />
      <span className="meta tnum">≈ {fmtUsd(gemasToUsd(total))} at issuance</span>
      <SimulatedYieldLabel />
    </section>
  );
}

/** Redeemable now vs pending: always shown together, never one merged number. */
export function BalanceSplit({
  redeemable,
  pending,
  redeemableSources,
}: {
  redeemable: number;
  pending: number;
  /** Number of Sources the redeemable Gemas sit on. */
  redeemableSources?: number;
}) {
  return (
    <div className="split">
      <div className="cut cut-card now">
        <span className="label">Redeemable now</span>
        <b>{fmtGemas(redeemable)}</b>
        <span className="tnum">
          ≈ {fmtUsd(gemasToUsd(redeemable))}
          {redeemableSources ? ` · ${redeemableSources} Source${redeemableSources === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="cut cut-card">
        <span className="label">Pending</span>
        <b>{fmtGemas(pending)}</b>
        <span>Redeemable as each Source&apos;s yield accrues</span>
      </div>
    </div>
  );
}

export interface PendingSourceItem {
  key: string;
  chain: Chain;
  owner: string;
  pending: number;
  /** Share of the Source's yield accrued so far (0..1). */
  accruedShare: number;
}

export function PendingBySource({ items }: { items: PendingSourceItem[] }) {
  return (
    <div className="src">
      <Label>Pending by Source</Label>
      {items.length === 0 && <p className="meta">Nothing pending.</p>}
      {items.map((it) => (
        <div className="src-item" key={it.key}>
          <div className="src-line">
            <ChainChip chain={it.chain} />
            <span className="src-who">{it.owner}</span>
            <span className="src-amt">{fmtGemas(it.pending)}</span>
          </div>
          <Meter value={it.accruedShare} label={`${it.owner} yield accrued`} />
          <div className="src-foot">
            <span>{Math.round(it.accruedShare * 100)}% of yield accrued</span>
            <span>Pending</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export interface CrossChainStep {
  title: string;
  note: string;
}

const STEPS: CrossChainStep[] = [
  { title: "Source confirmed", note: "Advance confirmed on the source chain" },
  { title: "Message verified", note: "Cross-chain message verified on Solana" },
  { title: "Gemas available", note: "Gemas credited to your Account" },
];

/**
 * Cross-chain transfer progress. `stage` is the number of steps completed (0..steps.length).
 * Success is only ever shown at the last stage: pending never shows success early. `steps` defaults
 * to the three-step Advance; the last step reads "Available" (Gemas) unless `finalState` says otherwise.
 */
export function CrossChainProgress({
  stage,
  failed = false,
  chain,
  txHash,
  steps = STEPS,
  label,
  finalState = "Available",
  doneText = "Gemas available. They are yours to play.",
  pendingText = "Pending. These Gemas are not available until the last step completes.",
  failedText = "This step failed. Your Gemas are not available; nothing was spent.",
}: {
  stage: number;
  /** The current step failed. */
  failed?: boolean;
  chain?: Chain;
  txHash?: string;
  steps?: CrossChainStep[];
  label?: string;
  finalState?: string;
  doneText?: string;
  pendingText?: string;
  failedText?: string;
}) {
  const last = steps.length;
  const allDone = stage >= last && !failed;
  return (
    <div className="stack">
      <div className="spread">
        <Label>{label ?? (chain ? `${chain} → Gemas` : "Cross-chain")}</Label>
        {txHash && <span className="mono meta">{txHash}</span>}
      </div>
      <ol className="xc" aria-label="Cross-chain progress">
        {steps.map(({ title, note }, i) => {
          const isLast = i === last - 1;
          let state: "done" | "active" | "waiting" | "failed" | "available";
          if (i < stage) state = isLast ? "available" : "done";
          else if (i === stage) state = failed ? "failed" : "active";
          else state = "waiting";
          const stateText = { done: "Done", available: finalState, active: "In progress", waiting: "Waiting", failed: "Failed" }[state];
          const Icon = { done: CheckIcon, available: CheckIcon, active: ClockIcon, waiting: MinusIcon, failed: XIcon }[state];
          return (
            <li key={title} className={state} aria-current={state === "active" ? "step" : undefined}>
              <span className="cut cut-chip xc-icon"><Icon /></span>
              <span>
                <span className="xc-title">{title}</span>
                <br />
                <span className="xc-note">{note}</span>
              </span>
              <span className="xc-state">{stateText}</span>
            </li>
          );
        })}
      </ol>
      <p className="note" role="status">
        {allDone ? doneText : failed ? failedText : pendingText}
      </p>
    </div>
  );
}
