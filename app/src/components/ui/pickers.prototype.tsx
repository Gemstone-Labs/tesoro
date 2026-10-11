"use client";

/**
 * PROTOTYPE ONLY (branch proto/pickers-11-10-2026). Four directions for the pickers: entry, asset, chip and
 * slider, switched together by `?variant=` (the pink bar, or ←/→). The real EntryPicker, AssetPicker, Chip and
 * Slider route here unless the variant is `now`. Throw away once a direction is picked.
 *   A Rail        one connected track per control, a lit piece slides to the choice
 *   B Stones      tactile objects: the Gema grows with the stake, chains are cut tokens, stepper slider
 *   C Tickets     vertical list rows that show what the choice means (the win), numbered ruler slider
 *   D Quiet type  no boxes: the numbers are the control, hairline slider with a value tag on the thumb
 */
import { createContext, useContext, useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import type { EntrySize } from "@/lib/mock/types";
import { fmtGemas } from "@/lib/format";
import { GemaMark } from "./gema";
import "./pickers.prototype.css";

export const PICKER_VARIANTS = [
  { key: "A", name: "Rail" },
  { key: "B", name: "Stones" },
  { key: "C", name: "Tickets" },
  { key: "D", name: "Quiet type" },
  { key: "now", name: "Current" },
] as const;
export type PickerVariant = (typeof PICKER_VARIANTS)[number]["key"];
export type ProtoVariant = Exclude<PickerVariant, "now">;

const KEYS = PICKER_VARIANTS.map((v) => v.key);
/** Pins a variant for a subtree (the side-by-side gallery); otherwise the bar decides. */
export const PickerVariantPin = createContext<PickerVariant | null>(null);
export function usePickerVariant(): PickerVariant {
  const pinned = useContext(PickerVariantPin);
  const fromBar = usePrototypeVariant(KEYS);
  return pinned ?? fromBar;
}

const SIZES: readonly EntrySize[] = [500, 1000, 2500];
const ASSETS = [
  { id: 0, symbol: "SOL", name: "Solana" },
  { id: 1, symbol: "ETH", name: "Ethereum" },
  { id: 2, symbol: "HYPE", name: "Hyperliquid" },
] as const;
/** Platform 2% + Studio 3% + Leaderboard 1% of the Pot (devnet terms). */
const winFor = (entry: number) => entry * 2 - Math.floor((entry * 2 * 600) / 10_000);

const css = (o: Record<string, string | number>) => o as CSSProperties;

export function ChainGlyph({ id, size = 20 }: { id: 0 | 1 | 2; size?: number }) {
  const uid = useId();
  if (id === 0)
    return (
      <svg className="pp-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id={uid} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="1" stopColor="#19fb9b" />
          </linearGradient>
        </defs>
        <path fill={`url(#${uid})`} d="M6.5 5h15l-3 3.2h-15zM3.5 10.4h15l3 3.2h-15zM6.5 15.8h15l-3 3.2h-15z" />
      </svg>
    );
  if (id === 1)
    return (
      <svg className="pp-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#a9b8f5" d="M12 2 18.5 12.3 12 16.1z" />
        <path fill="#8299ee" d="M12 2 5.5 12.3 12 16.1z" />
        <path fill="#627eea" d="M12 17.4 18.5 13.6 12 22z" />
        <path fill="#4a63c9" d="M12 17.4 5.5 13.6 12 22z" />
      </svg>
    );
  return (
    <svg className="pp-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#97fce4"
        d="M1.8 12c0-4 2.6-6.2 5.2-6.2 3.6 0 4 4.2 5 4.2s1.4-4.2 5-4.2c2.6 0 5.2 2.2 5.2 6.2s-2.6 6.2-5.2 6.2c-3.6 0-4-4.2-5-4.2s-1.4 4.2-5 4.2c-2.6 0-5.2-2.2-5.2-6.2z"
      />
    </svg>
  );
}

/* ——— Entry ——— */

type EntryProps = {
  value: EntrySize;
  onChange: (v: EntrySize) => void;
  legend?: string;
  name?: string;
  maxAffordable?: number;
  isDisabled?: (size: EntrySize) => boolean;
};

export function EntryPickerProto({ variant, value, onChange, legend = "Entry", name, maxAffordable, isDisabled }: EntryProps & { variant: ProtoVariant }) {
  const auto = useId();
  const group = name ?? auto;
  const idx = Math.max(0, SIZES.indexOf(value));
  const off = (s: EntrySize) => (maxAffordable !== undefined && s > maxAffordable) || (isDisabled?.(s) ?? false);
  const radio = (s: EntrySize) => (
    <input type="radio" name={group} value={s} checked={value === s} disabled={off(s)} onChange={() => onChange(s)} />
  );
  const legendEl = <legend className="sr-only">{legend}</legend>;

  if (variant === "A")
    return (
      <fieldset className={`cut pp-root ppa-rail ppa-entry${off(value) ? " off" : ""}`} style={css({ "--i": idx, "--n": SIZES.length })}>
        {legendEl}
        <span className="ppa-thumb" aria-hidden="true" />
        {SIZES.map((s) => (
          <label key={s} className="ppa-opt">
            {radio(s)}
            <span className={value === s ? "pp-ink" : undefined}>
              <GemaMark size={15} />
              {fmtGemas(s)}
            </span>
          </label>
        ))}
      </fieldset>
    );

  if (variant === "B")
    return (
      <fieldset className="pp-root ppb-row">
        {legendEl}
        {SIZES.map((s, i) => (
          <label key={s} className="ppb-opt ppb-entry">
            {radio(s)}
            <span className="cut ppb-card">
              <span className="ppb-stone" style={css({ "--s": `${[22, 32, 44][i]}px` })}>
                <GemaMark size={[22, 32, 44][i]} glint={value === s} />
              </span>
              <b>{fmtGemas(s)}</b>
            </span>
          </label>
        ))}
      </fieldset>
    );

  if (variant === "C")
    return (
      <fieldset className="pp-root ppc-list">
        {legendEl}
        {SIZES.map((s) => (
          <label key={s} className="ppc-opt">
            {radio(s)}
            <span className="cut ppc-row">
              <i className="ppc-dot" aria-hidden="true" />
              <b className="ppc-amt">
                <GemaMark size={16} />
                {fmtGemas(s)}
              </b>
              <span className="ppc-side">{off(s) ? "Not enough Gemas" : <>Win <b>{fmtGemas(winFor(s))}</b></>}</span>
            </span>
          </label>
        ))}
      </fieldset>
    );

  return (
    <fieldset className="pp-root ppd-row">
      {legendEl}
      {SIZES.map((s) => (
        <label key={s} className="ppd-opt ppd-entry">
          {radio(s)}
          <span>
            <GemaMark size={18} />
            <b>{fmtGemas(s)}</b>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/* ——— Asset ——— */

export function AssetPickerProto({ variant, value, onChange, name }: { variant: ProtoVariant; value: 0 | 1 | 2; onChange: (v: 0 | 1 | 2) => void; name?: string }) {
  const auto = useId();
  const group = name ?? auto;
  const radio = (id: 0 | 1 | 2) => <input type="radio" name={group} value={id} checked={value === id} onChange={() => onChange(id)} />;
  const legendEl = <legend className="sr-only">Asset</legend>;

  if (variant === "A")
    return (
      <fieldset className="cut pp-root ppa-rail ppa-asset" style={css({ "--i": value, "--n": 3 })}>
        {legendEl}
        <span className="ppa-thumb" aria-hidden="true" />
        {ASSETS.map((a) => (
          <label key={a.id} className="ppa-opt">
            {radio(a.id)}
            <span>
              <ChainGlyph id={a.id} size={18} />
              <b>{a.symbol}</b>
              <small>{a.name}</small>
            </span>
          </label>
        ))}
      </fieldset>
    );

  if (variant === "B")
    return (
      <fieldset className="pp-root ppb-row">
        {legendEl}
        {ASSETS.map((a) => (
          <label key={a.id} className="ppb-opt ppb-asset" style={css({ "--chain": ["#9945ff", "#627eea", "#97fce4"][a.id] })}>
            {radio(a.id)}
            <span className="cut ppb-card">
              <span className="cut ppb-token">
                <ChainGlyph id={a.id} size={26} />
              </span>
              <b>{a.symbol}</b>
            </span>
          </label>
        ))}
      </fieldset>
    );

  if (variant === "C")
    return (
      <fieldset className="pp-root ppc-list">
        {legendEl}
        {ASSETS.map((a) => (
          <label key={a.id} className="ppc-opt">
            {radio(a.id)}
            <span className="cut ppc-row ppc-asset">
              <i className="ppc-dot" aria-hidden="true" />
              <b className="ppc-amt">
                <ChainGlyph id={a.id} size={18} />
                {a.symbol}
              </b>
              <span className="ppc-side">{a.name}</span>
            </span>
          </label>
        ))}
      </fieldset>
    );

  return (
    <fieldset className="pp-root ppd-row">
      {legendEl}
      {ASSETS.map((a) => (
        <label key={a.id} className="ppd-opt ppd-asset">
          {radio(a.id)}
          <span>
            <b>{a.symbol}</b>
            <small>{a.name}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/* ——— Chip ——— */

export type ChipTone = "neutral" | "strong" | "money" | "warn" | "danger";

export function ChipProto({ variant, tone = "neutral", icon, children }: { variant: ProtoVariant; tone?: ChipTone; icon?: ReactNode; children: ReactNode }) {
  const cls = `ppchip pp${variant.toLowerCase()}-chip t-${tone}`;
  if (variant === "B" || variant === "D")
    return (
      <span className={variant === "B" ? `cut ${cls}` : cls}>
        {icon ?? <i className="ppchip-dot" aria-hidden="true" />}
        {children}
      </span>
    );
  return (
    <span className={variant === "C" ? `cut ${cls}` : cls}>
      {icon}
      {children}
    </span>
  );
}

/** Client island so the server-safe Chip can follow the switcher. */
export function ChipSwitch({ tone, icon, children, now }: { tone?: ChipTone; icon?: ReactNode; children: ReactNode; now: ReactNode }) {
  const pv = usePickerVariant();
  if (pv === "now") return <>{now}</>;
  return <ChipProto variant={pv} tone={tone} icon={icon}>{children}</ChipProto>;
}

/* ——— Slider ——— */

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display: ReactNode;
  minLabel?: string;
  maxLabel?: string;
};

export function SliderProto({ variant, label, value, min, max, step = 1, onChange, display, minLabel, maxLabel }: SliderProps & { variant: ProtoVariant }) {
  const id = useId();
  const steps = Math.max(1, Math.round((max - min) / step));
  const f = (value - min) / (max - min || 1);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const range = (
    <input
      id={id}
      className="pp-range"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
  const vars = css({ "--f": f, "--n": steps + 1 });

  if (variant === "A") {
    const cells = steps <= 24;
    return (
      <div className="pp-slider ppa-slider" style={vars}>
        <div className="slider-head">
          <label className="label" htmlFor={id}>{label}</label>
          <span className="slider-value">{display}</span>
        </div>
        <div className="pp-track ppa-track">
          {cells ? (
            <div className="ppa-cells" aria-hidden="true">
              {Array.from({ length: steps + 1 }, (_, i) => (
                <i key={i} className={min + i * step <= value ? "on" : undefined} />
              ))}
            </div>
          ) : (
            <div className="ppa-bar" aria-hidden="true">
              <i />
            </div>
          )}
          <span className="ppa-marker" aria-hidden="true" />
          {range}
        </div>
        <div className="slider-ticks" aria-hidden="true">
          <span>{minLabel ?? min}</span>
          <span>{maxLabel ?? max}</span>
        </div>
      </div>
    );
  }

  if (variant === "B")
    return (
      <div className="pp-slider ppb-slider" style={vars}>
        <label className="label" htmlFor={id}>{label}</label>
        <div className="ppb-stepper">
          <button type="button" className="cut ppb-step" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
            −
          </button>
          <output className="ppb-value" htmlFor={id}>{display}</output>
          <button type="button" className="cut ppb-step" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
            +
          </button>
        </div>
        <div className="pp-track ppb-track">
          <div className="ppb-line" aria-hidden="true">
            <i />
          </div>
          <span className="ppb-knob" aria-hidden="true" />
          {range}
        </div>
        <div className="slider-ticks" aria-hidden="true">
          <span>{minLabel ?? min}</span>
          <span>{maxLabel ?? max}</span>
        </div>
      </div>
    );

  if (variant === "C") {
    // every value labelled up to 12 steps; past that five evenly spaced stops snapped to the step
    const marks =
      steps <= 12
        ? Array.from({ length: steps + 1 }, (_, i) => min + i * step)
        : Array.from({ length: 5 }, (_, i) => clamp(min + Math.round(((max - min) * i) / 4 / step) * step));
    const fmt = (v: number) => (v === min && minLabel && steps > 12 ? minLabel : v === max && maxLabel && steps > 12 ? maxLabel : v.toLocaleString("en-US"));
    return (
      <div className="pp-slider ppc-slider" style={vars}>
        <div className="slider-head">
          <label className="label" htmlFor={id}>{label}</label>
          <span className="slider-value">{display}</span>
        </div>
        <div className="pp-track ppc-track">
          <div className="ppc-rule" aria-hidden="true">
            <i />
          </div>
          <span className="ppc-pin" aria-hidden="true" />
          {range}
        </div>
        <div className="ppc-marks" aria-hidden="true">
          {marks.map((m) => (
            <button
              key={m}
              type="button"
              tabIndex={-1}
              className={m === value ? "now" : m < value ? "past" : undefined}
              style={css({ "--m": (m - min) / (max - min || 1) })}
              onClick={() => onChange(m)}
            >
              {fmt(m)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="pp-slider ppd-slider" style={vars}>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="pp-track ppd-track">
        <div className="ppd-line" aria-hidden="true">
          <i />
        </div>
        {steps <= 24 && (
          <div className="ppd-dots" aria-hidden="true">
            {Array.from({ length: steps + 1 }, (_, i) => (
              <i key={i} className={min + i * step <= value ? "on" : undefined} />
            ))}
          </div>
        )}
        <span className="ppd-knob" aria-hidden="true">
          <span className="cut ppd-tag">{display}</span>
        </span>
        {range}
      </div>
      <div className="slider-ticks" aria-hidden="true">
        <span>{minLabel ?? min}</span>
        <span>{maxLabel ?? max}</span>
      </div>
    </div>
  );
}
