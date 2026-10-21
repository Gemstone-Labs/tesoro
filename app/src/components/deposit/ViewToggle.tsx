"use client";

import { useId } from "react";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import type { ViewMode } from "@/lib/deposit/view-mode";
import "./deposit.css";

const OPTIONS: { mode: ViewMode; label: string }[] = [
  { mode: "simple", label: "Simple" },
  { mode: "advanced", label: "Advanced" },
];

/**
 * Simple | Advanced, as the steel rail of Trading Duel's asset picker. On the Vault it switches the saved view in place;
 * inside a Get Gemas modal it shows that modal's view (`value`) and `onPick` swaps to the other modal.
 */
export function ViewToggle({ value, onPick, className }: { value?: ViewMode; onPick?: (mode: ViewMode) => void; className?: string }) {
  const { mode, setMode } = useViewMode();
  const name = useId();
  const shown = value ?? mode;
  const pick = (next: ViewMode) => {
    if (next === shown) return;
    setMode(next);
    onPick?.(next);
  };
  return (
    <fieldset
      className={`cut pick-rail assets compact view-rail${className ? ` ${className}` : ""}`}
      style={{ ["--n" as string]: OPTIONS.length, ["--i" as string]: OPTIONS.findIndex((o) => o.mode === shown) }}
    >
      <legend className="sr-only">View</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {OPTIONS.map((o) => (
        <label key={o.mode} className="asset">
          <input type="radio" name={name} value={o.mode} checked={shown === o.mode} onChange={() => pick(o.mode)} />
          <span className="cut">
            <b>{o.label}</b>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
