import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import type { Chain } from "@/lib/mock/types";
import { CountUp } from "./CountUp";
import { GemaMark } from "./gema";
import { ChainGlyph } from "./inputs";
import { ChainChip, Label, Meter } from "./primitives";

/** The balance as a banknote: the card is the money fill, figure and Gema mark in ink. The only place the glint runs. */
export function BalanceCard({ total, title = "Your Gemas" }: { total: number; title?: string }) {
  return (
    <section className="cut cut-card balance" aria-label={title}>
      <div className="balance-top">
        <span className="balance-label">{title}</span>
        <span className="balance-usd">≈ {fmtUsd(gemasToUsd(total))}</span>
      </div>
      <div className="balance-fig">
        <GemaMark size={38} glint />
        <span>
          <CountUp value={total} />
          <span className="sr-only"> Gemas</span>
        </span>
      </div>
      <div className="balance-foot">
        <span>Value at issuance</span>
      </div>
    </section>
  );
}

/**
 * Redeemable now vs pending: always shown together, never one merged number. One bar drawn to scale
 * (emerald redeemable, hatched pending), each figure under its own end.
 */
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
  const total = redeemable + pending;
  const share = total > 0 ? redeemable / total : 0;
  const pct = Math.round(share * 100);
  return (
    <div className="cut cut-card bsplit">
      <div className="bsplit-bar" role="img" aria-label={`${pct}% redeemable now, ${100 - pct}% pending`}>
        {redeemable > 0 && <i className="now" style={{ flexGrow: share }} />}
        {pending > 0 && <i className="pend" style={{ flexGrow: 1 - share }} />}
      </div>
      <div className="bsplit-now">
        <span className="label"><i />Redeemable now</span>
        <b><GemaMark size={18} />{fmtGemas(redeemable)}</b>
        <span className="tnum">
          ≈ {fmtUsd(gemasToUsd(redeemable))}
          {redeemableSources ? ` · from ${redeemableSources} Advance${redeemableSources === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="bsplit-pend">
        <span className="label"><i />Pending</span>
        <b>{fmtGemas(pending)}</b>
        <span>As each Lock&apos;s yield is earned</span>
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
      <Label>Pending by Lock</Label>
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
  { title: "Lock confirmed", note: "Advance confirmed on the origin chain" },
  { title: "Message verified", note: "Cross-chain message verified on Solana" },
  { title: "Gemas available", note: "Gemas credited to your Account" },
];

/** One end of a cross-chain route: a chain, or the player's Account on Solana. */
export type CrossChainEnd = Chain | "account";

const END_NAME: Record<CrossChainEnd, string> = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM", account: "Your Account" };
const END_ASSET = { SOL: 0, ETH: 1, HYPE: 2 } as const;

function EndMark({ end }: { end: CrossChainEnd }) {
  return end === "account" ? <GemaMark size={26} /> : <ChainGlyph asset={END_ASSET[end]} size={26} />;
}

type StepState = "done" | "available" | "active" | "waiting" | "failed";

/**
 * Cross-chain transfer progress as a route: the source and destination as tiles, the steps between them as
 * stations on a track, and a packet travelling the leg being worked on. `stage` is the number of steps completed
 * (0..steps.length). The first step lights the source tile, the last the destination; success is only ever shown
 * at the last stage, so pending never shows success early. `steps` defaults to the three-step Advance; the last
 * step reads "Available" (Gemas) unless `finalState` says otherwise. `from` defaults to `chain`, `to` to the Account.
 */
export function CrossChainProgress({
  stage,
  failed = false,
  chain,
  from = chain ?? "ETH",
  to = "account",
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
  from?: CrossChainEnd;
  to?: CrossChainEnd;
  txHash?: string;
  steps?: CrossChainStep[];
  label?: string;
  finalState?: string;
  doneText?: string;
  pendingText?: string;
  failedText?: string;
}) {
  const last = steps.length;
  const legs = Math.max(1, last - 1);
  const allDone = stage >= last && !failed;
  const current = Math.min(stage, last - 1);
  const states: StepState[] = steps.map((_, i) => {
    if (i < stage) return i === last - 1 ? "available" : "done";
    if (i === stage) return failed ? "failed" : "active";
    return "waiting";
  });
  const word = (s: StepState) => ({ done: "Done", available: finalState, active: "In progress", waiting: "Waiting", failed: "Failed" })[s];
  const step = steps[current];
  // the packet sits on the leg leading to the step being worked on, or on the source while it confirms
  const packet = stage === 0 ? 0 : (current - 0.5) / legs;

  return (
    <div className={`xc${allDone ? " is-done" : failed ? " is-failed" : ""}`}>
      <div className="spread">
        <Label>{label ?? (chain ? `${chain} → Gemas` : "Cross-chain")}</Label>
        {txHash && <span className="mono meta">{txHash}</span>}
      </div>
      <div className="xc-route" aria-hidden="true">
        <span className={`xc-end cut cut-card ${states[0]}`}><EndMark end={from} /></span>
        <span className="xc-track">
          {states.slice(1).map((s, i) => (
            <span key={i} className={`xc-leg ${s}`} />
          ))}
          {states.slice(1, -1).map((s, i) => (
            <span key={i} className={`xc-stop cut ${s}`} style={{ left: `${((i + 1) / legs) * 100}%` }} title={steps[i + 1].title} />
          ))}
          {!allDone && <span className={`xc-packet${failed ? " failed" : ""}`} style={{ left: `${packet * 100}%` }} />}
        </span>
        <span className={`xc-end cut cut-card ${states[last - 1]}`}><EndMark end={to} /></span>
      </div>
      <div className="xc-names" aria-hidden="true">
        <span>{END_NAME[from]}</span>
        <span>{END_NAME[to]}</span>
      </div>
      <ol className="sr-only" aria-label="Cross-chain progress">
        {steps.map(({ title }, i) => (
          <li key={title} aria-current={states[i] === "active" ? "step" : undefined}>
            {title}: {word(states[i])}
          </li>
        ))}
      </ol>
      <div className="xc-now" role="status">
        <span className="xc-state">{allDone ? finalState : `Step ${current + 1} of ${last} · ${word(states[current])}`}</span>
        <strong>{step.title}</strong>
        <span className="xc-note">{allDone ? doneText : failed ? failedText : step.note}</span>
      </div>
      {!allDone && !failed && <p className="note">{pendingText}</p>}
    </div>
  );
}
