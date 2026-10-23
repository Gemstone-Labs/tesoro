"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FacetCrown, GemaMark, GemaUsd, SimulatedYieldLabel } from "@/components/ui";
import { InfoTip } from "./Tip";
import "@/app/(app)/wallet/wallet.css";

export interface HeroColumn {
  label: string;
  /** The figure, already formatted; "—" while loading. */
  figure: ReactNode;
  /** Gemas the ≈ dollar figure is worked out from; omit to hide it. */
  usdOf?: number;
  /** Money that can move now: the emerald column. */
  emerald?: boolean;
  /** An ⓘ next to the label that explains the figure. */
  info?: ReactNode;
  action?: ReactNode;
  /** A small line under the action. */
  note?: ReactNode;
}

/**
 * The green cut balance card at the top of the Vault, the same in both views: one big figure on the left, two columns on
 * the right. On phones it folds to the big figure plus `summary`, and opens on tap.
 */
export function BalanceHero({ label, labelInfo, figure, usdOf, busy = false, summary, totalNote, columns, winnings, error, simulated = true }: {
  label: string;
  /** An ⓘ next to the main label that explains the total. */
  labelInfo?: ReactNode;
  figure: ReactNode;
  usdOf?: number;
  busy?: boolean;
  /** The one-line summary a folded phone card shows instead of the columns. */
  summary?: ReactNode;
  /** A small line under the big figure (e.g. Gemas in play, counted in none of the columns). */
  totalNote?: ReactNode;
  /** Two or three columns on the right. */
  columns: HeroColumn[];
  /** The Simple view: one Winnings row under the big figure (with its Cash out) instead of the columns, and no fold. */
  winnings?: { figure: ReactNode; usdOf?: number; action: ReactNode };
  error?: ReactNode;
  /** Show the simulated-yield label (test mode). */
  simulated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={`cut cut-frame facet-panel wl-hero${columns.length > 2 ? " three" : ""}${open ? " open" : ""}${winnings ? " simple" : ""}`} aria-label={label}>
      <FacetCrown />
      <div className="wl-total" onClick={() => setOpen((o) => !o)}>
        <div className="wl-total-head">
          <h2 className="wl-col-head">
            {label}
            {labelInfo && (
              <InfoTip label={`About ${label}`} align="start">
                {labelInfo}
              </InfoTip>
            )}
          </h2>
          {!winnings && (
            <button type="button" className="wl-fold" aria-expanded={open} aria-controls={id}>
              <ChevronDown size={18} aria-hidden="true" />
              <span className="sr-only">{open ? "Hide" : "Show"} {columns.map((c) => c.label).join(", ")}</span>
            </button>
          )}
        </div>
        <div className="wl-total-fig">
          <GemaMark size={72} glint />
          <b aria-busy={busy}>{figure}</b>
          <span>Gemas</span>
        </div>
        {usdOf !== undefined && <GemaUsd className="wl-usd wl-total-usd" value={usdOf} />}
        {totalNote && <p className="wl-total-note">{totalNote}</p>}
        {summary && !open && (
          <button type="button" className="wl-sum" aria-expanded={open} aria-controls={id}>
            {summary}
          </button>
        )}
      </div>
      {winnings && (
        <div className="wl-win" aria-label="Winnings">
          <span className="wl-col-head">Winnings</span>
          <span className="wl-win-fig">
            <GemaMark size={28} />
            <b>{winnings.figure}</b>
            {winnings.usdOf !== undefined && <GemaUsd className="wl-usd" value={winnings.usdOf} />}
          </span>
          {winnings.action}
        </div>
      )}
      {!winnings && <div className="wl-second" id={id}>
        {columns.map((c, i) => (
          <div key={c.label} className={c.emerald ? "wl-redeemable" : "wl-pending"} aria-label={c.label}>
            <h2 className="wl-col-head">
              {c.label}
              {c.info && (
                <InfoTip label={`About ${c.label}`} align={i === columns.length - 1 ? "end" : "center"}>
                  {c.info}
                </InfoTip>
              )}
            </h2>
            <b>{c.figure}</b>
            {c.usdOf !== undefined && <GemaUsd className="wl-usd" value={c.usdOf} />}
            {c.action}
            {c.note && <span className="meta">{c.note}</span>}
          </div>
        ))}
      </div>}
      {error}
      {simulated && <SimulatedYieldLabel className="wl-hero-sim" />}
    </section>
  );
}
