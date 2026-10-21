"use client";

import { useId } from "react";
import { Button } from "@/components/ui";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import type { ViewMode } from "@/lib/deposit/view-mode";
import { requestGetGemas } from "@/lib/get-gemas";

const OPTIONS: { mode: ViewMode; label: string }[] = [
  { mode: "simple", label: "Simple" },
  { mode: "advanced", label: "Advanced" },
];

/** The same header in both views: title and rate on the left, Get Gemas on the right. */
export function VaultHeader() {
  const { mode } = useViewMode();
  return (
    <header className="page-head vt-head">
      <div>
        <h1 className="page-title">Vault</h1>
        <p className="page-sub">1 Gema = $0.01</p>
      </div>
      <Button variant="money" size="lg" onClick={() => (mode === "simple" ? requestDeposit() : requestGetGemas())}>Get Gemas</Button>
    </header>
  );
}

/** Simple | Advanced, under the balance card: the same steel rail as Trading Duel's asset picker; it switches what's below the card, in place. */
export function ViewToggle() {
  const { mode, setMode } = useViewMode();
  const name = useId();
  return (
    <fieldset className="cut pick-rail assets compact vt-rail" style={{ ["--n" as string]: OPTIONS.length, ["--i" as string]: OPTIONS.findIndex((o) => o.mode === mode) }}>
      <legend className="sr-only">View</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {OPTIONS.map((o) => (
        <label key={o.mode} className="asset">
          <input type="radio" name={name} value={o.mode} checked={mode === o.mode} onChange={() => setMode(o.mode)} />
          <span className="cut">
            <b>{o.label}</b>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
