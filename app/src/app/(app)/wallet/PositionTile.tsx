"use client";

import { type ReactNode, useId, useState } from "react";
import { ChevronDown, Lock, LockOpen } from "lucide-react";
import { ChainGlyph, SimulatedYieldLabel } from "@/components/ui";
import { fmtInMinutes } from "@/lib/format";
import type { Chain } from "@/lib/mock/types";
import "./wallet.css";

/** Debt over time, projected from the live yield rate: `vals[i]` is the Debt at `labels[i]`. */
export interface DebtSeries {
  vals: number[];
  labels: string[];
}

const TICKS = 4;

const spanLabel = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `+${s}s` : `+${Math.round(s / 60)}m`;
};

/** Debt falls linearly with the yield clock, so a series is fully set by Debt now and when it reaches zero. */
export function linearSeries(debtNow: number, nowMs: number, zeroAtMs: number | null): DebtSeries {
  const span = zeroAtMs && zeroAtMs > nowMs ? zeroAtMs - nowMs : 10 * 60_000;
  const vals = Array.from({ length: TICKS + 1 }, (_, i) => (zeroAtMs && zeroAtMs > nowMs ? Math.max(0, debtNow * (1 - i / TICKS)) : debtNow));
  const labels = ["Now", ...Array.from({ length: TICKS }, (_, i) => spanLabel((span * (i + 1)) / TICKS))];
  return { vals, labels };
}

/** Sampled series (native Positions: the real projected Debt at each step). */
export function sampledSeries(sample: (atMs: number) => number, nowMs: number, spanMs: number): DebtSeries {
  const span = Math.max(spanMs, 60_000);
  const vals = Array.from({ length: TICKS + 1 }, (_, i) => sample(nowMs + (span * i) / TICKS));
  const labels = ["Now", ...Array.from({ length: TICKS }, (_, i) => spanLabel((span * (i + 1)) / TICKS))];
  return { vals, labels };
}

/**
 * `repaying`: Debt is open and yield pays it down. `paid`: Debt is zero, the Principal can be unlocked.
 * `idle`: locked, no Advance taken. `unlocked`: the Principal is back.
 */
export type PositionState = "repaying" | "paid" | "idle" | "unlocked";

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;

/** "17:02" big, "Today" / "Tomorrow" / "Oct 12" beside the time left. */
function backAt(at: number, now: number) {
  const d = new Date(at);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  const date = days === 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { time: d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }), when: `${date} · ${fmtInMinutes(at, now)}` };
}

function hero(state: PositionState, unlockAt: number | null, now: number) {
  if (state === "repaying") {
    if (!unlockAt) return { k: "Unlock Estimate", big: "Soon", note: "Once yield accrues" };
    const b = backAt(unlockAt, now);
    return { k: "Unlock Estimate", big: b.time, note: b.when };
  }
  if (state === "paid") return { k: "Unlock Estimate", big: "Now", note: "Paid back: unlock any time" };
  if (state === "unlocked") return { k: "Locked amount", big: "Returned", note: "This Lock is closed" };
  return { k: "Locked amount", big: "Locked", note: "Earning yield · no Advance taken" };
}

/** Projected Debt draining to zero, across the card. */
function BurnDown({ series, debt }: { series: DebtSeries; debt: string }) {
  const id = useId();
  const W = 240;
  const H = 70;
  const max = Math.max(...series.vals, 1e-9);
  const n = series.vals.length - 1;
  const line = series.vals.map((v, i) => `${i ? "L" : "M"}${((i / n) * W).toFixed(1)},${(2 + (1 - v / max) * (H - 4)).toFixed(1)}`).join("");
  const last = series.labels.length - 1;
  return (
    <figure className="wl-burn">
      <figcaption>
        <b>{debt}</b> left to pay back · yield pays it to zero <span>· projected</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Left to pay back, projected: ${debt} now, zero at ${series.labels[last]}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="wl-burn-axis" aria-hidden="true">
        {series.labels.map((l, i) => (
          <span key={i}>{i === last ? `${l} · 0` : l}</span>
        ))}
      </div>
    </figure>
  );
}

/**
 * One Position as a countdown: when the Principal comes back, the projected Debt burning down to zero, then
 * Principal / Debt / Yield, the actions, and the card's small print behind Details. Folded by default to the
 * countdown and a one-line Debt; a tap anywhere on that part opens the rest.
 */
export function PositionTile({
  chain,
  label,
  state,
  principal,
  debt,
  debtAsset,
  apy,
  yieldFeeBps,
  unlockAt,
  now,
  series,
  notes,
  defaultOpen = false,
  compact = false,
  children,
}: {
  chain: Chain;
  label: string;
  state: PositionState;
  principal: string;
  /** Debt in Gemas (or the asset, offline); null without an Advance. */
  debt: string | null;
  /** The same Debt in the Position's asset, under the Gemas figure. */
  debtAsset?: string;
  /** The Position's yield rate after the Yield Fee. */
  apy: string;
  /** Shows "after the N% Yield Fee" under the rate. */
  yieldFeeBps?: number;
  /** Unlock Estimate (ms) while repaying. */
  unlockAt: number | null;
  now: number;
  series: DebtSeries | null;
  notes?: ReactNode;
  defaultOpen?: boolean;
  /** Folded to one line (label, Principal, when it comes back) instead of the countdown; a tap opens the whole card. */
  compact?: boolean;
  children?: ReactNode;
}) {
  const h = hero(state, unlockAt, now);
  const unlocked = state === "unlocked";
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const flat = state === "repaying" ? (series && debt ? `${debt} left to pay back` : "Waiting for the first yield") : "Nothing to pay back";
  if (compact && !open) {
    const [day, rel] = h.note.split(" · ");
    const when = state === "repaying" ? (unlockAt ? `Back ${/^To/.test(day) ? day.toLowerCase() : day} ${h.big} · ${rel}` : "Back once yield accrues") : state === "paid" ? "Paid off · unlock any time" : h.note;
    return (
      <article className={`cut wl-row ${state}`} aria-label={label}>
        <button type="button" className="wl-row-btn" aria-expanded={false} onClick={() => setOpen(true)}>
          <ChainGlyph asset={GLYPH[chain]} size={18} />
          <b>{label}</b>
          <span className="wl-row-p">{principal}</span>
          <span className="wl-row-when">{when}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </article>
    );
  }
  return (
    <article className={`cut cut-card wl-tile ${state}${open ? " open" : ""}`} aria-label={label}>
      <div className="wl-tile-top" onClick={() => setOpen((o) => !o)}>
        <header className="wl-tile-head">
          <ChainGlyph asset={GLYPH[chain]} size={20} />
          <b>{label}</b>
          <span className="wl-tile-lock">
            {unlocked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
            <span className="sr-only">{unlocked ? "Unlocked:" : "Locked:"}</span> {principal}
          </span>
          <button type="button" className="wl-fold" aria-expanded={open} aria-controls={bodyId}>
            <ChevronDown size={18} aria-hidden="true" />
            <span className="sr-only">{open ? "Hide" : "Show"} {label} details</span>
          </button>
        </header>
        <div className="wl-back">
          <span className="label">{h.k}</span>
          <b>{h.big}</b>
          <span>{h.note}</span>
        </div>
        {open && series && debt ? <BurnDown series={series} debt={debt} /> : <p className="wl-burn-flat">{flat}</p>}
      </div>
      <div className="wl-tile-body" id={bodyId} hidden={!open}>
        <dl className="wl-facts">
          <div>
            <dt>Locked amount</dt>
            <dd>{principal}</dd>
          </div>
          <div>
            <dt>Left to pay back</dt>
            <dd>
              {debt ?? "None"}
              {debtAsset && <small>{debtAsset}</small>}
            </dd>
          </div>
          <div>
            <dt>Yield</dt>
            <dd>
              {apy}
              {yieldFeeBps !== undefined && <small>after the {yieldFeeBps / 100}% Yield Fee</small>}
            </dd>
          </div>
        </dl>
        <SimulatedYieldLabel />
        <div className="wl-actions">{children}</div>
        {notes && (
          <details className="wl-more">
            <summary>Details</summary>
            {notes}
          </details>
        )}
      </div>
    </article>
  );
}
