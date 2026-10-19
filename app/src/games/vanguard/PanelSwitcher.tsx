"use client";

import { PANEL_NAMES, PANEL_STYLES, type PanelStyle } from "./panels";

/** Temporary Practice-only control to flip the side-panel takes live. */
export function PanelSwitcher({ value, onChange }: { value: PanelStyle; onChange: (s: PanelStyle) => void }) {
  return (
    <div className="vg-switcher" role="group" aria-label="Side panel style">
      <span>Panels</span>
      {PANEL_STYLES.map((s) => (
        <button key={s} type="button" aria-pressed={value === s} title={PANEL_NAMES[s]} onClick={() => onChange(s)}>
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
