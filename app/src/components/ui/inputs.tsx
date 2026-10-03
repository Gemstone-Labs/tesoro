"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { EntrySize } from "@/lib/mock/types";
import { fmtGemas } from "@/lib/format";
import { GemaMark } from "./gema";
import { XIcon } from "./icons";

export const ENTRY_SIZES: readonly EntrySize[] = [500, 1000, 2500];

/** The assets Trading Duel can trade, by `?asset=` index (see lib/chain/match-id.ts). */
export const DUEL_ASSETS = [
  { id: 0, symbol: "SOL", name: "Solana" },
  { id: 1, symbol: "ETH", name: "Ethereum" },
  { id: 2, symbol: "HYPE", name: "Hyperliquid" },
] as const;

/** Radio group over Trading Duel's assets. Neutral: the chosen asset is pale, never emerald (no Gemas move here). */
/** `compact` shows the tickers only (the Lobby hero), with the asset name kept for screen readers. */
export function AssetPicker({ value, onChange, name, compact }: { value: 0 | 1 | 2; onChange: (v: 0 | 1 | 2) => void; name?: string; compact?: boolean }) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className={compact ? "assets compact" : "assets"}>
      <legend className="sr-only">Asset</legend>
      {DUEL_ASSETS.map((a) => (
        <label key={a.id} className="asset">
          <input type="radio" name={group} value={a.id} checked={value === a.id} onChange={() => onChange(a.id)} />
          <span className="cut cut-chip">
            <b>{a.symbol}</b>
            <small className={compact ? "sr-only" : undefined}>{a.name}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Radio group over the entry ladder. The chosen entry is emerald and carries the Gema mark. */
export function EntryPicker({
  value,
  onChange,
  legend = "Entry",
  name,
  maxAffordable,
  isDisabled,
}: {
  value: EntrySize;
  onChange: (v: EntrySize) => void;
  legend?: string;
  name?: string;
  /** Entries above this many Gemas are disabled. */
  maxAffordable?: number;
  /** Extra rule for an entry that `maxAffordable` cannot express (e.g. Gemas spread over too many Sources). */
  isDisabled?: (size: EntrySize) => boolean;
}) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className="entries">
      <legend className="sr-only">{legend}</legend>
      {ENTRY_SIZES.map((size) => {
        const disabled = (maxAffordable !== undefined && size > maxAffordable) || (isDisabled?.(size) ?? false);
        return (
          <label key={size} className="entry">
            <input
              type="radio"
              name={group}
              value={size}
              checked={value === size}
              disabled={disabled}
              onChange={() => onChange(size)}
            />
            <span className="cut cut-chip">
              {value === size && <GemaMark size={14} />}
              {fmtGemas(size)}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Native range input, styled with the cut. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
  minLabel,
  maxLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display: ReactNode;
  minLabel?: string;
  maxLabel?: string;
}) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  const steps = Math.round((max - min) / step);
  return (
    <div className="slider">
      <div className="slider-head">
        <label className="label" htmlFor={id}>{label}</label>
        <span className="slider-value">{display}</span>
      </div>
      <div className="slider-track">
        {steps <= 24 && (
          <div className="slider-notches" aria-hidden="true">
            {Array.from({ length: steps + 1 }, (_, i) => (
              <i key={i} className={min + i * step <= value ? "on" : undefined} />
            ))}
          </div>
        )}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          style={{ ["--pct" as string]: `calc(14px + (100% - 28px) * ${pct / 100})` }}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <div className="slider-ticks" aria-hidden="true">
        <span>{minLabel ?? min}</span>
        <span>{maxLabel ?? max}</span>
      </div>
    </div>
  );
}

/** Modal bottom sheet on phones, centred dialog on wide screens. Uses native <dialog> for focus trap and Esc. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="cut cut-frame sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="sheet-in">
          <div className="sheet-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="cut cut-chip icon-btn" onClick={onClose} aria-label="Close">
              <XIcon />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
