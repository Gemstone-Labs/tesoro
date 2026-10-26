"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { EntrySize, GameId } from "@/lib/mock/types";
import { GAME_NAMES } from "@/lib/mock";
import { fmtGemas } from "@/lib/format";
import { GemaMark, GemaUsd } from "./gema";
import { XIcon } from "./icons";

export { ENTRY_SIZES } from "@/lib/cluster-settings";
import { ENTRY_SIZES } from "@/lib/cluster-settings";

/** The assets Trading Duel can trade, by `?asset=` index (see lib/chain/match-id.ts). */
export const DUEL_ASSETS = [
  { id: 0, symbol: "SOL", name: "Solana" },
  { id: 1, symbol: "ETH", name: "Ethereum" },
  { id: 2, symbol: "HYPE", name: "Hyperliquid" },
] as const;

/** A chain's mark in its brand colours, flat, for pickers. */
export function ChainGlyph({ asset, size = 18 }: { asset: 0 | 1 | 2; size?: number }) {
  const uid = useId();
  return (
    <svg className="chain-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {asset === 0 && (
        <>
          <defs>
            <linearGradient id={uid} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#9945ff" />
              <stop offset="1" stopColor="#19fb9b" />
            </linearGradient>
          </defs>
          <path fill={`url(#${uid})`} d="M6.5 5h15l-3 3.2h-15zM3.5 10.4h15l3 3.2h-15zM6.5 15.8h15l-3 3.2h-15z" />
        </>
      )}
      {asset === 1 && (
        <>
          <path fill="#a9b8f5" d="M12 2 18.5 12.3 12 16.1z" />
          <path fill="#8299ee" d="M12 2 5.5 12.3 12 16.1z" />
          <path fill="#627eea" d="M12 17.4 18.5 13.6 12 22z" />
          <path fill="#4a63c9" d="M12 17.4 5.5 13.6 12 22z" />
        </>
      )}
      {asset === 2 && (
        <path
          fill="#97fce4"
          d="M1.8 12c0-4 2.6-6.2 5.2-6.2 3.6 0 4 4.2 5 4.2s1.4-4.2 5-4.2c2.6 0 5.2 2.2 5.2 6.2s-2.6 6.2-5.2 6.2c-3.6 0-4-4.2-5-4.2s-1.4 4.2-5 4.2c-2.6 0-5.2-2.2-5.2-6.2z"
        />
      )}
    </svg>
  );
}

/**
 * Radio group over Trading Duel's assets, as a rail: a steel piece slides to the chosen asset. Neutral, never
 * emerald (no Gemas move here). `compact` keeps the asset name for screen readers only.
 */
export function AssetPicker({ value, onChange, name, compact }: { value: 0 | 1 | 2; onChange: (v: 0 | 1 | 2) => void; name?: string; compact?: boolean }) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className={`cut pick-rail assets${compact ? " compact" : ""}`} style={{ ["--i" as string]: value }}>
      <legend className="sr-only">Asset</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {DUEL_ASSETS.map((a) => (
        <label key={a.id} className="asset">
          <input type="radio" name={group} value={a.id} checked={value === a.id} onChange={() => onChange(a.id)} />
          <span className="cut">
            <ChainGlyph asset={a.id} />
            <b>{a.symbol}</b>
            <small className={compact ? "sr-only" : undefined}>{a.name}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Radio group over Games, as a rail with a steel piece (choosing a Game moves no Gemas). */
export function GamePicker({ games, value, onChange, name }: { games: GameId[]; value: GameId; onChange: (g: GameId) => void; name?: string }) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className="cut pick-rail games" style={{ ["--i" as string]: Math.max(0, games.indexOf(value)), ["--n" as string]: games.length }}>
      <legend className="sr-only">Game</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {games.map((g) => (
        <label key={g} className="game">
          <input type="radio" name={group} value={g} checked={value === g} onChange={() => onChange(g)} />
          <span className="cut">{GAME_NAMES[g]}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A two-way (or n-way) view switch as one cut rail: the chosen option is a lit steel piece. For views of the same page, such as
 * Requests / My Backings; it moves no Gemas, so it is never emerald. A radio group, so arrow keys move the choice; each option is 44px tall.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  name,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  /** What the switch chooses, for screen readers. */
  label: string;
  name?: string;
}) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className="cut pick-rail segmented" style={{ ["--i" as string]: Math.max(0, options.findIndex((o) => o.value === value)), ["--n" as string]: options.length }}>
      <legend className="sr-only">{label}</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {options.map((o) => (
        <label key={o.value} className="seg">
          <input type="radio" name={group} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="cut">{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Radio group over the entry ladder, as a rail: an emerald piece slides to the chosen entry. */
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
  const off = (size: EntrySize) => (maxAffordable !== undefined && size > maxAffordable) || (isDisabled?.(size) ?? false);
  return (
    <fieldset className={`cut pick-rail entries${off(value) ? " off" : ""}`} style={{ ["--i" as string]: Math.max(0, ENTRY_SIZES.indexOf(value)) }}>
      <legend className="sr-only">{legend}</legend>
      <span className="pick-thumb" aria-hidden="true" />
      {ENTRY_SIZES.map((size) => (
        <label key={size} className="entry">
          <input type="radio" name={group} value={size} checked={value === size} disabled={off(size)} onChange={() => onChange(size)} />
          <span className="cut">
            <GemaMark size={15} />
            <span className="entry-fig">
              {fmtGemas(size)}
              <GemaUsd value={size} />
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The ends plus round values between them (1-2-2.5-5 steps, about five gaps); none crowding an end. */
function roundMarks(min: number, max: number, step: number): number[] {
  const raw = (max - min) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((n) => n >= raw) ?? 10 * mag;
  const gap = Math.max(step, Math.round(nice / step) * step);
  const inner: number[] = [];
  for (let v = Math.ceil(min / gap) * gap; v < max; v += gap) if (v - min > gap / 2 && max - v > gap / 2) inner.push(v);
  return [min, ...inner, max];
}

/**
 * Native range input drawn as a ruler: every value written under it up to 12 steps (round values past that),
 * a pin pointing at the current one. The marks are shortcuts for the pointer; the range itself carries
 * keyboard and screen reader use. `format` writes the marks (default: the end labels, plain numbers between).
 */
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
  format,
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
  format?: (v: number) => string;
}) {
  const id = useId();
  const span = max - min || 1;
  const steps = Math.round(span / step);
  const marks = steps <= 12 ? Array.from({ length: steps + 1 }, (_, i) => min + i * step) : roundMarks(min, max, step);
  const write = (v: number) =>
    format ? format(v) : steps > 12 && v === min && minLabel ? minLabel : steps > 12 && v === max && maxLabel ? maxLabel : v.toLocaleString("en-US");
  return (
    <div className="slider" style={{ ["--f" as string]: (value - min) / span }}>
      <div className="slider-head">
        <label className="label" htmlFor={id}>{label}</label>
        <span className="slider-value">{display}</span>
      </div>
      <div className="slider-track">
        <div className="slider-rule" aria-hidden="true">
          <i />
        </div>
        <span className="slider-pin" aria-hidden="true" />
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
      <div className="slider-marks" aria-hidden="true">
        {marks.map((m) => (
          <button
            key={m}
            type="button"
            tabIndex={-1}
            className={m === value ? "now" : m < value ? "past" : undefined}
            style={{ ["--m" as string]: (m - min) / span }}
            onClick={() => onChange(m)}
          >
            {write(m)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Modal bottom sheet on phones, centred dialog on wide screens. Uses native <dialog> for focus trap and Esc. */
export function Sheet({
  open,
  onClose,
  title,
  lead,
  actions,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown above the title inside the header (e.g. the Tesoro mark on the Sign in sheet). */
  lead?: ReactNode;
  /** Shown beside the close button (e.g. the Pro view switch on the Buy Gemas sheets). */
  actions?: ReactNode;
  className?: string;
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
      className={`cut cut-frame sheet${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="sheet-in">
          <div className="sheet-head">
            {lead}
            <h2 id={titleId}>{title}</h2>
            {/* Close comes first in the DOM so opening the sheet focuses it, not one of the actions */}
            <button type="button" className="cut cut-chip icon-btn" onClick={onClose} aria-label="Close">
              <XIcon />
            </button>
            {actions && <div className="sheet-actions">{actions}</div>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
