"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import "./deposit.css";

/**
 * The Vault's gear: a small panel with the Pro view switch. Off is the Simple view (deposit packs); on is the Pro view
 * (SOL, ETH or HYPE, any amount, 1 to 12 months). It switches the saved view in place. Escape or a click outside closes it.
 */
export function ViewSettings({ className }: { className?: string }) {
  const { mode, setMode } = useViewMode();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const label = useId();
  const pro = mode === "advanced";

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div
      className={`vs${className ? ` ${className}` : ""}`}
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="vs-gear"
        aria-label="Vault settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Settings size={22} aria-hidden="true" />
      </button>
      {open && (
        <div id={panel} className="cut vs-panel" role="dialog" aria-label="Vault settings">
          <div className="vs-row">
            <div className="vs-text">
              <span id={label}>Pro view</span>
              <small>Deposit SOL, ETH or HYPE yourself: you choose how much and for how long.</small>
            </div>
            <button
              type="button"
              role="switch"
              className="vs-switch"
              aria-checked={pro}
              aria-labelledby={label}
              onClick={() => setMode(pro ? "simple" : "advanced")}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
