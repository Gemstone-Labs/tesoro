"use client";

import { useId } from "react";
import { InfoTip } from "@/components/money/Tip";
import "./deposit.css";

export const PRO_VIEW_TIP = "Deposit SOL, ETH or HYPE yourself: you choose how much and for how long.";

/**
 * "Pro view ⓘ" and its switch: on the Vault and in both Buy Gemas modals. Off is the Simple view (deposit packs); on is
 * the Pro view (SOL, ETH or HYPE, any amount, 1 to 12 months).
 */
export function ProViewSwitch({ on, onChange, className }: { on: boolean; onChange: (on: boolean) => void; className?: string }) {
  const label = useId();
  return (
    <div className={`pv${className ? ` ${className}` : ""}`}>
      <span id={label} className="pv-label">Pro view</span>
      <InfoTip label="About Pro view" align="end" side="below">{PRO_VIEW_TIP}</InfoTip>
      <button type="button" role="switch" className="vs-switch" aria-checked={on} aria-labelledby={label} onClick={() => onChange(!on)}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
