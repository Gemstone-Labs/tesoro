"use client";

import type { ReactNode } from "react";
import { CountUp, GemaMark } from "@/components/ui";
import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import "./advance-sheet.css";

export const monthsLabel = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;

/** Shared by Take an Advance and Open a Position: the yield over the Horizon flowing into "You get now". */
export function YieldToGemas({ months, yieldText, gemas }: { months: number; yieldText: string; gemas: number }) {
  return (
    <div className="adv-swap">
      <div className="adv-in">
        <span className="label">Yield over {monthsLabel(months)}</span>
        <b>{yieldText}</b>
      </div>
      <svg className="adv-flow" viewBox="0 0 44 16" aria-hidden>
        <path d="M4 3l5 5-5 5M17 3l5 5-5 5M30 3l5 5-5 5" />
      </svg>
      <div className="adv-out cut cut-card">
        <span className="label">You get now</span>
        <span className="adv-fig">
          <GemaMark size={26} />
          {gemas > 0 ? <CountUp value={gemas} duration={400} /> : "0"}
        </span>
        <span className="adv-usd">{gemas > 0 ? fmtUsd(gemasToUsd(gemas)) : "—"}</span>
      </div>
    </div>
  );
}

/** Now → Unlock Estimate on a dashed line. */
export function UnlockTrack({ now, unlock, end }: { now: ReactNode; unlock: string; end: ReactNode }) {
  return (
    <div className="adv-track">
      <span><b>Now</b> {now}</span>
      <span className="adv-track-line" aria-hidden />
      <span><b>{unlock}</b> {end}</span>
    </div>
  );
}

/** The money button's label: the action, then the Gema mark and the amount. */
export function GemasLabel({ action, gemas }: { action: string; gemas: number }) {
  return gemas > 0 ? (
    <>
      {action} · <GemaMark size={18} /> {fmtGemas(gemas)}
    </>
  ) : (
    <>{action}</>
  );
}
