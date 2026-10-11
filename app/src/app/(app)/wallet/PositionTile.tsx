"use client";

import { type ReactNode, useId } from "react";
import { Lock, LockOpen } from "lucide-react";
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
    if (!unlockAt) return { k: "Principal back", big: "Soon", note: "Once yield accrues" };
    const b = backAt(unlockAt, now);
    return { k: "Principal back", big: b.time, note: b.when };
  }
  if (state === "paid") return { k: "Principal back", big: "Now", note: "Debt is zero: unlock any time" };
  if (state === "unlocked") return { k: "Principal", big: "Returned", note: "This Position is closed" };
  return { k: "Principal", big: "Locked", note: "Earning yield · no Advance taken" };
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
        <b>{debt}</b> of Debt now · yield pays it to zero <span>· projected</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Debt, projected: ${debt} now, zero at ${series.labels[last]}`}>
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
 * Principal / Debt / Yield, the actions, and the card's small print behind Details.
 */
export function PositionTile({
  chain,
  label,
  state,
  principal,
  debt,
  debtAsset,
  apy,
  unlockAt,
  now,
  series,
  notes,
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
  apy: string;
  /** Unlock Estimate (ms) while repaying. */
  unlockAt: number | null;
  now: number;
  series: DebtSeries | null;
  notes?: ReactNode;
  children?: ReactNode;
}) {
  const h = hero(state, unlockAt, now);
  const open = state === "unlocked";
  return (
    <article className={`cut cut-card wl-tile ${state}`} aria-label={label}>
      <header className="wl-tile-head">
        <ChainGlyph asset={GLYPH[chain]} size={20} />
        <b>{label}</b>
        <span className="wl-tile-lock">
          {open ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
          <span className="sr-only">{open ? "Unlocked:" : "Locked:"}</span> {principal}
        </span>
      </header>
      <div className="wl-back">
        <span className="label">{h.k}</span>
        <b>{h.big}</b>
        <span>{h.note}</span>
      </div>
      {series && debt ? (
        <BurnDown series={series} debt={debt} />
      ) : (
        <p className="wl-burn-flat">{state === "repaying" ? "Waiting for the first yield" : "No Debt"}</p>
      )}
      <dl className="wl-facts">
        <div>
          <dt>Principal</dt>
          <dd>{principal}</dd>
        </div>
        <div>
          <dt>Debt</dt>
          <dd>
            {debt ?? "None"}
            {debtAsset && <small>{debtAsset}</small>}
          </dd>
        </div>
        <div>
          <dt>Yield</dt>
          <dd>{apy}</dd>
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
    </article>
  );
}
