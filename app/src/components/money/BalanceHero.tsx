import type { ReactNode } from "react";
import { FacetCrown, GemaMark, GemaUsd, SimulatedYieldLabel } from "@/components/ui";
import "./balance-hero.css";

export interface HeroColumn {
  label: string;
  /** The figure, already formatted; "—" while loading. */
  figure: string;
  /** Gemas the ≈ dollar figure is worked out from; omit to hide it. */
  usdOf?: number;
  /** Colours the figure emerald: money that can move now. */
  emerald?: boolean;
  /** A small line under the dollars. */
  note?: ReactNode;
  action?: ReactNode;
}

/**
 * The green cut balance card (the Wallet's Total Balance look): one big figure on the left, two smaller columns on the
 * right. Used by the Vault; the Wallet keeps its own markup until the economy rewrite lands.
 */
export function BalanceHero({ label, figure, usdOf, sub, columns, busy = false, error }: {
  label: string;
  figure: string;
  usdOf?: number;
  sub?: ReactNode;
  columns: [HeroColumn, HeroColumn];
  busy?: boolean;
  error?: ReactNode;
}) {
  return (
    <section className="cut cut-frame facet-panel bh" aria-label={label}>
      <FacetCrown />
      <div className="bh-total">
        <h2>{label}</h2>
        <div className="bh-total-fig">
          <GemaMark size={72} glint />
          <b aria-busy={busy}>{figure}</b>
          <span>Gemas</span>
          {usdOf !== undefined && <GemaUsd className="bh-usd" value={usdOf} />}
        </div>
        {sub && <p className="bh-sum">{sub}</p>}
      </div>
      <div className="bh-second">
        {columns.map((c) => (
          <div key={c.label} className="bh-col" aria-label={c.label}>
            <h2>{c.label}</h2>
            <b className={c.emerald ? "em" : undefined}>{c.figure}</b>
            {c.usdOf !== undefined && <GemaUsd className="bh-usd" value={c.usdOf} />}
            {c.note && <span className="meta">{c.note}</span>}
            {c.action}
          </div>
        ))}
      </div>
      {error && <div className="bh-err">{error}</div>}
      <SimulatedYieldLabel className="bh-sim" />
    </section>
  );
}
