"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { EntrySize } from "@/lib/mock/types";
import { fmtGemas } from "@/lib/format";
import { GemaMark } from "./gema";
import { XIcon } from "./icons";

export const ENTRY_SIZES: readonly EntrySize[] = [500, 1000, 2500];

/** Radio group over the entry ladder. The chosen entry is emerald and carries the Gema mark. */
export function EntryPicker({
  value,
  onChange,
  legend = "Entry",
  name,
  maxAffordable,
}: {
  value: EntrySize;
  onChange: (v: EntrySize) => void;
  legend?: string;
  name?: string;
  /** Entries above this many Gemas are disabled. */
  maxAffordable?: number;
}) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className="entries">
      <legend className="sr-only">{legend}</legend>
      {ENTRY_SIZES.map((size) => {
        const disabled = maxAffordable !== undefined && size > maxAffordable;
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
  return (
    <div className="slider">
      <div className="slider-head">
        <label className="label" htmlFor={id}>{label}</label>
        <span className="slider-value">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ["--pct" as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
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
