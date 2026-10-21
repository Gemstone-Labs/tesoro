"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FacetCrown, GemaMark, GemaUsd, SimulatedYieldLabel } from "@/components/ui";
import "@/app/(app)/wallet/wallet.css";

export interface HeroColumn {
  label: string;
  /** The figure, already formatted; "—" while loading. */
  figure: ReactNode;
  /** Gemas the ≈ dollar figure is worked out from; omit to hide it. */
  usdOf?: number;
  /** Money that can move now: the emerald column. */
  emerald?: boolean;
  action?: ReactNode;
  /** A small line under the action. */
  note?: ReactNode;
}

/**
 * The green cut balance card at the top of the Vault, the same in both views: one big figure on the left, two columns on
 * the right. On phones it folds to the big figure plus `summary`, and opens on tap.
 */
export function BalanceHero({ label, figure, usdOf, busy = false, summary, columns, error, simulated = true }: {
  label: string;
  figure: ReactNode;
  usdOf?: number;
  busy?: boolean;
  /** The one-line summary a folded phone card shows instead of the columns. */
  summary?: ReactNode;
  columns: [HeroColumn, HeroColumn];
  error?: ReactNode;
  /** Show the simulated-yield label (test mode). */
  simulated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={`cut cut-frame facet-panel wl-hero${open ? " open" : ""}`} aria-label={label}>
      <FacetCrown />
      <div className="wl-total" onClick={() => setOpen((o) => !o)}>
        <div className="wl-total-head">
          <h2>{label}</h2>
          <button type="button" className="wl-fold" aria-expanded={open} aria-controls={id}>
            <ChevronDown size={18} aria-hidden="true" />
            <span className="sr-only">{open ? "Hide" : "Show"} {columns[0].label} and {columns[1].label}</span>
          </button>
        </div>
        <div className="wl-total-fig">
          <GemaMark size={72} glint />
          <b aria-busy={busy}>{figure}</b>
          <span>Gemas</span>
          {usdOf !== undefined && <GemaUsd className="wl-usd" value={usdOf} />}
        </div>
        {summary && !open && (
          <button type="button" className="wl-sum" aria-expanded={open} aria-controls={id}>
            {summary}
          </button>
        )}
      </div>
      <div className="wl-second" id={id}>
        {columns.map((c) => (
          <div key={c.label} className={c.emerald ? "wl-redeemable" : "wl-pending"} aria-label={c.label}>
            <h2>{c.label}</h2>
            <b>{c.figure}</b>
            {c.usdOf !== undefined && <GemaUsd className="wl-usd" value={c.usdOf} />}
            {c.action}
            {c.note && <span className="meta">{c.note}</span>}
          </div>
        ))}
      </div>
      {error}
      {simulated && <SimulatedYieldLabel className="wl-hero-sim" />}
    </section>
  );
}
