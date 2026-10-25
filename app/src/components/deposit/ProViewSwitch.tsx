"use client";

import { useId } from "react";
import { InfoTip } from "@/components/money/Tip";
import "./deposit.css";

export const PRO_VIEW_TIP = "Deposit SOL, ETH or HYPE yourself: you choose how much and for how long.";

/**
 * "Pro view" and its switch: on the Vault (with an ⓘ at the label's top right) and in both Buy Gemas modals (no ⓘ). Off is
 * the Simple view (deposit packs); on is the Pro view (SOL, ETH or HYPE, any amount, 1 to 12 months).
 */
export function ProViewSwitch({ on, onChange, tip = true, className }: { on: boolean; onChange: (on: boolean) => void; tip?: boolean; className?: string }) {
  const label = useId();
  return (
    <div className={`pv${className ? ` ${className}` : ""}`}>
      <span className="pv-label">
        <span id={label}>Pro view</span>
        {tip && <InfoTip label="About Pro view" align="end">{PRO_VIEW_TIP}</InfoTip>}
      </span>
      <button type="button" role="switch" className="cut vs-switch" aria-checked={on} aria-labelledby={label} onClick={() => onChange(!on)}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
