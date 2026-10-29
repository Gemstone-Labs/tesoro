"use client";

import type { ReactNode } from "react";
import { FacetCrown, GemaMark, GemaUsd } from "@/components/ui";
import { SkelText } from "@/components/ui/skel-text";
import { InfoTip } from "./Tip";
import "@/app/(app)/wallet/wallet.css";

export interface HeroRow {
  label: string;
  /** The figure, already formatted; replaced by a skeleton while busy. */
  figure: ReactNode;
  /** The text the loading bar is sized from; the typical figure, so the row takes its usual lines. */
  placeholder?: string;
  /** Gemas the ≈ dollar figure is worked out from; omit to hide it. */
  usdOf?: number;
  /** Money that can move now. */
  emerald?: boolean;
  /** An ⓘ next to the label that explains the figure. */
  info?: ReactNode;
  action?: ReactNode;
  /** A small line under the action. */
  note?: ReactNode;
}

/** Both Vault views share one balance figure followed by always-visible money rows. */
export function BalanceHero({ label, labelInfo, figure, usdOf, busy = false, totalNote, rows, error }: {
  label: string;
  /** An ⓘ next to the main label that explains the total. */
  labelInfo?: ReactNode;
  figure: ReactNode;
  usdOf?: number;
  busy?: boolean;
  /** A small line under the big figure (e.g. Gemas in play). */
  totalNote?: ReactNode;
  rows: HeroRow[];
  error?: ReactNode;
}) {
  return (
    <section className="cut cut-frame facet-panel wl-hero" aria-label={label} aria-busy={busy}>
      <FacetCrown />
      {busy && <span className="sr-only" role="status">Loading your Gemas…</span>}
      <div className="wl-total">
        <h2 className="wl-col-head">
          {label}
          {labelInfo && <InfoTip label={`About ${label}`} align="start">{labelInfo}</InfoTip>}
        </h2>
        <div className="wl-total-fig">
          <GemaMark size={72} glint />
          <b>{busy ? <SkelText>0,000</SkelText> : figure}</b>
        </div>
        {busy ? <SkelText className="wl-usd wl-total-usd">≈ $00</SkelText> : usdOf !== undefined && <GemaUsd className="wl-usd wl-total-usd" value={usdOf} />}
        {totalNote && <p className="wl-total-note">{totalNote}</p>}
      </div>
      {rows.map((row) => (
        <div key={row.label} className={`wl-win${row.emerald ? " emerald" : ""}`} aria-label={row.label}>
          <h2 className="wl-col-head">
            {row.label}
            {row.info && <InfoTip label={`About ${row.label}`} align="start">{row.info}</InfoTip>}
          </h2>
          <span className="wl-win-fig">
            <GemaMark size={28} />
            <b>{busy ? <SkelText>{row.placeholder ?? "0,000"}</SkelText> : row.figure}</b>
            {busy ? <SkelText className="wl-usd">≈ $0</SkelText> : row.usdOf !== undefined && <GemaUsd className="wl-usd" value={row.usdOf} />}
          </span>
          {row.action && <div className="wl-win-action">{row.action}</div>}
          {!busy && row.note && <span className="wl-win-note">{row.note}</span>}
        </div>
      ))}
      {error}
    </section>
  );
}
