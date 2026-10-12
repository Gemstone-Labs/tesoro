"use client";

import { useId, type ReactNode } from "react";
import { Bust, BustCard, Button, ChainGlyph, Slider } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
import { UnlockTrack, YieldToGemas, monthsLabel } from "./AdvanceQuote";
import "./wallet.css";

export const CHAINS: Chain[] = ["SOL", "ETH", "HYPE"];

/** him-explain with the one-line model. Never says "protected": the Principal is locked and never played. */
export function HowGemasWork() {
  return (
    <BustCard bust="himExplain" size={132} className="wl-how">
      <b>How Gemas work</b>
      <p>Lock a Position.</p>
      <p>Take an Advance in Gemas.</p>
      <p>Your Principal is never played.</p>
    </BustCard>
  );
}

const HOW_STEPS: [string, string][] = [
  ["Lock a Position", "Your Principal is locked, never played."],
  ["Take an Advance", "Its projected yield for 1 to 12 months, less Tesoro's Yield Fee, upfront as Gemas."],
  ["Yield repays it", "The Position unlocks when its Debt reaches zero."],
];

/** No Positions yet: the invitation, the explainer and the action in one card (it replaces HowGemasWork). */
export function NoPositions({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="cut cut-card wl-empty">
      <Bust name="himExplain" width={200} className="wl-empty-bust" />
      <div className="wl-empty-lead">
        <b>No Positions yet</b>
        <p>Open a Position to get Gemas to play with.</p>
      </div>
      <Button variant="money" onClick={onOpen}>Open a Position</Button>
      <ol className="wl-steps" aria-label="How Gemas work">
        {HOW_STEPS.map(([title, text], i) => (
          <li key={title}>
            <span aria-hidden="true">{i + 1}</span>
            <div>
              <b>{title}</b>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const PRESETS: [string, number][] = [["25%", 0.25], ["50%", 0.5], ["Max", 1]];

/**
 * The OPEN A POSITION form body, built like the Take an Advance sheet but led by the deposit: an editable
 * "Lock SOL · New Position" card where that sheet has its locked Position, then yield → Gemas, the Horizon,
 * Now → Unlock Estimate and the money button.
 */
export function OpenFormView({
  chain,
  apy,
  amountText,
  onAmount,
  amountInvalid = false,
  balance,
  max,
  months,
  onMonths,
  gemas,
  yieldText,
  estimate,
  arrival = "Position opens, Gemas in your balance",
  yieldFeeBps,
  details,
  alerts,
  note,
  buttonLabel,
  disabled,
  onSubmit,
  head,
  inert = false,
}: {
  chain: Chain;
  /** "7% APY", once known. */
  apy?: string;
  amountText: string;
  onAmount: (v: string) => void;
  amountInvalid?: boolean;
  /** Under the amount: the balance and how to get more. */
  balance?: ReactNode;
  /** The balance as a number: shows 25% / 50% / Max. */
  max?: number;
  months: number;
  onMonths: (m: number) => void;
  gemas: number | null;
  /** The Position's yield over the Horizon, with its unit. */
  yieldText: string;
  estimate: string;
  /** What happens now, on the left of the Unlock line. */
  arrival?: string;
  /** The Yield Fee the quote is net of (the launch rate while the Treasury is unread). */
  yieldFeeBps?: number;
  details?: [string, ReactNode][];
  alerts?: ReactNode;
  note?: ReactNode;
  buttonLabel: ReactNode;
  disabled: boolean;
  onSubmit: () => void;
  head?: ReactNode;
  /** No market yet: the form shows its shape but cannot be edited. */
  inert?: boolean;
}) {
  const id = useId();
  const presets = !inert && max !== undefined && max > 0;
  return (
    <div className="wl-open-form">
      {head}
      <div className={`cut cut-card wl-deposit${amountInvalid ? " bad" : ""}`}>
        <div className="wl-deposit-head">
          <ChainGlyph asset={GLYPH[chain]} size={30} />
          <div>
            <label htmlFor={id}>Lock {chain}</label>
            <span className="meta">{apy ? `${apy} · ` : ""}locked, never played</span>
          </div>
          <span className="wl-new">New Position</span>
        </div>
        <div className="wl-amount">
          <input id={id} inputMode="decimal" placeholder="0" value={amountText} disabled={inert} onChange={(e) => onAmount(e.target.value)} aria-invalid={amountInvalid} />
          <span>{chain}</span>
        </div>
        {(balance || presets) && (
          <div className="wl-deposit-foot">
            {balance && <div className="meta wl-balance">{balance}</div>}
            {presets && (
              <div className="wl-presets">
                {PRESETS.map(([label, f]) => (
                  <button key={label} type="button" className="cut cut-chip" onClick={() => onAmount(String(Math.floor(max * f * 1000) / 1000))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <YieldToGemas months={months} yieldText={yieldText} gemas={gemas ?? 0} yieldFeeBps={yieldFeeBps} />
      <Slider label="Horizon" value={months} min={1} max={12} onChange={onMonths} display={monthsLabel(months)} format={(m) => `${m}`} />
      <UnlockTrack now={arrival} unlock={estimate} end={`Unlock Estimate, your ${chain} back`} />
      {alerts}
      {note && <p className="note">{note}</p>}
      <Button variant="money" size="lg" block disabled={disabled} onClick={onSubmit}>
        {buttonLabel}
      </Button>
      {details && (
        <details className="wl-details">
          <summary>Quote details</summary>
          <dl className="kv">
            {details.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/** Chain tabs + the active chain's form. */
export function OpenPanel({ tab, onTab, children }: { tab: Chain; onTab: (c: Chain) => void; children: ReactNode }) {
  return (
    <section className="wl-open" id="open-position" aria-label="Open a Position">
      <div className="wl-tabs" role="tablist" aria-label="Chain">
        {CHAINS.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={tab === c} className={`cut cut-card${tab === c ? " on" : ""}`} onClick={() => onTab(c)}>
            {c}
          </button>
        ))}
      </div>
      <div role="tabpanel">{children}</div>
    </section>
  );
}
