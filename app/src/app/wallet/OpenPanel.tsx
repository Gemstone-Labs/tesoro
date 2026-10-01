"use client";

import { useId, type ReactNode } from "react";
import { BustCard, Button, GemaAmount, Slider } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
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

/** The OPEN A POSITION form body: Amount, Horizon, the quote, how it works, and the money button. */
export function OpenFormView({
  unit,
  amountText,
  onAmount,
  amountInvalid = false,
  amountHint,
  months,
  onMonths,
  gemas,
  estimate,
  details,
  alerts,
  note,
  buttonLabel,
  disabled,
  onSubmit,
  head,
  inert = false,
}: {
  unit: string;
  amountText: string;
  onAmount: (v: string) => void;
  amountInvalid?: boolean;
  amountHint?: ReactNode;
  months: number;
  onMonths: (m: number) => void;
  gemas: number | null;
  estimate: string;
  details?: [string, ReactNode][];
  alerts?: ReactNode;
  note?: ReactNode;
  buttonLabel: string;
  disabled: boolean;
  onSubmit: () => void;
  head?: ReactNode;
  /** No market yet: the form shows its shape but cannot be edited. */
  inert?: boolean;
}) {
  const id = useId();
  return (
    <div className="wl-open-form">
      {head}
      <div className="field">
        <label className="label" htmlFor={id}>Amount</label>
        <div className={`wl-amount${amountInvalid ? " bad" : ""}`}>
          <input id={id} className="tnum" inputMode="decimal" placeholder="0.0" value={amountText} disabled={inert} onChange={(e) => onAmount(e.target.value)} aria-invalid={amountInvalid} />
          <span>{unit}</span>
        </div>
        {amountHint && <span className="meta">{amountHint}</span>}
      </div>
      <Slider
        label="Horizon"
        value={months}
        min={1}
        max={12}
        onChange={onMonths}
        display={`${months} ${months === 1 ? "month" : "months"}`}
        minLabel="1 month"
        maxLabel="12 months"
      />
      <dl className="cut cut-card wl-quote">
        <dt>Gemas issued</dt>
        <dd>{gemas && gemas > 0 ? <GemaAmount value={gemas} size="md" /> : <span>— Gemas</span>}</dd>
        <dt>Unlock Estimate</dt>
        <dd>{estimate}</dd>
      </dl>
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
      {alerts}
      {note && <p className="note">{note}</p>}
      <Button variant="money" size="lg" block disabled={disabled} onClick={onSubmit}>
        {buttonLabel}
      </Button>
    </div>
  );
}

/** Chain tabs + the active chain's form. HYPE is not open yet. */
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
