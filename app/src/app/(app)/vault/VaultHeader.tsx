"use client";

import { Button } from "@/components/ui";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import type { ViewMode } from "@/lib/deposit/view-mode";
import { requestGetGemas } from "@/lib/get-gemas";

const OPTIONS: { mode: ViewMode; label: string }[] = [
  { mode: "simple", label: "Simple" },
  { mode: "advanced", label: "Advanced" },
];

/** The same header in both views: title and rate on the left, the view toggle and Get Gemas on the right. */
export function VaultHeader() {
  const { mode, setMode } = useViewMode();
  return (
    <header className="page-head vt-head">
      <div>
        <h1 className="page-title">Vault</h1>
        <p className="page-sub">1 Gema = $0.01</p>
      </div>
      <div className="vt-head-side">
        <div className="cut cut-chip vt-seg" role="group" aria-label="View">
          {OPTIONS.map((o) => (
            <button key={o.mode} type="button" className="vt-seg-opt" aria-pressed={mode === o.mode} onClick={() => setMode(o.mode)}>
              {o.label}
            </button>
          ))}
        </div>
        <Button variant="money" size="lg" onClick={() => (mode === "simple" ? requestDeposit() : requestGetGemas())}>Get Gemas</Button>
      </div>
    </header>
  );
}
