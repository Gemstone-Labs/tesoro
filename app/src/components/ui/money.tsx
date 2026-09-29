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

const STEPS = ["Source confirmed", "Message verified", "Gemas available"] as const;
const NOTES = [
  "Advance confirmed on the source chain",
  "Cross-chain message verified on Solana",
  "Gemas credited to your Account",
] as const;

/**
 * Cross-chain transfer progress. `stage` is the number of steps completed (0..3).
 * Success is only ever shown at stage 3: pending never shows success early.
 */
export function CrossChainProgress({
  stage,
  failed = false,
  chain,
  txHash,
}: {
  stage: 0 | 1 | 2 | 3;
  /** The current step failed. */
  failed?: boolean;
  chain?: Chain;
  txHash?: string;
}) {
  const allDone = stage === 3 && !failed;
  return (
    <div className="stack">
      <div className="spread">
        <Label>{chain ? `${chain} → Gemas` : "Cross-chain"}</Label>
        {txHash && <span className="mono meta">{txHash}</span>}
      </div>
      <ol className="xc" aria-label="Cross-chain progress">
        {STEPS.map((title, i) => {
          const isLast = i === STEPS.length - 1;
          let state: "done" | "active" | "waiting" | "failed" | "available";
          if (i < stage) state = isLast ? "available" : "done";
          else if (i === stage) state = failed ? "failed" : "active";
          else state = "waiting";
          const stateText = { done: "Done", available: "Available", active: "In progress", waiting: "Waiting", failed: "Failed" }[state];
          const Icon = { done: CheckIcon, available: CheckIcon, active: ClockIcon, waiting: MinusIcon, failed: XIcon }[state];
          return (
            <li key={title} className={state} aria-current={state === "active" ? "step" : undefined}>
              <span className="cut cut-chip xc-icon"><Icon /></span>
              <span>
                <span className="xc-title">{title}</span>
                <br />
                <span className="xc-note">{NOTES[i]}</span>
              </span>
              <span className="xc-state">{stateText}</span>
            </li>
          );
        })}
      </ol>
      <p className="note" role="status">
        {allDone
          ? "Gemas available. They are yours to play."
          : failed
            ? "This step failed. Your Gemas are not available; nothing was spent."
            : "Pending. These Gemas are not available until the last step completes."}
      </p>
    </div>
  );
}
