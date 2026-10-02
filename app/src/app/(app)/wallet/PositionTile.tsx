"use client";

import type { ReactNode } from "react";
import { SimulatedYieldLabel } from "@/components/ui";
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

const W = 300;
const H = 120;
const PAD = { l: 34, r: 8, t: 8, b: 4 };

/** Small projected-Debt chart. No series: an empty dashed axis (no Position). */
export function DebtChart({ title, series, fmt }: { title: string; series: DebtSeries | null; fmt: (n: number) => string }) {
  const max = series ? Math.max(...series.vals, 1e-9) : 1;
  const x = (i: number) => PAD.l + (i / TICKS) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [max, max / 2, 0];
  return (
    <figure className="wl-chart">
      <figcaption>
        {title} <span>· projected</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={series ? `${title}, projected: ${fmt(series.vals[0])} now, ${fmt(series.vals[series.vals.length - 1])} at the end` : `${title}: no data`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.l - 5} y={y(t) + 3.5} textAnchor="end">{series ? fmt(t) : ["1.0", "0.5", "0"][i]}</text>
          </g>
        ))}
        {series ? (
          <>
            <polyline points={series.vals.map((v, i) => `${x(i)},${y(v)}`).join(" ")} className="line" />
            {series.vals.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.4} className="dot" />
            ))}
            {series.labels.map((l, i) => (
              <text key={i} x={x(i)} y={H + 12} textAnchor={i === TICKS ? "end" : i === 0 ? "start" : "middle"}>{l}</text>
            ))}
          </>
        ) : (
          <>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(0.5)} y2={y(0.5)} className="empty" />
            {["Now", "7d", "14d", "21d", "28d"].map((l, i) => (
              <text key={i} x={x(i)} y={H + 12} textAnchor={i === TICKS ? "end" : i === 0 ? "start" : "middle"}>{l}</text>
            ))}
          </>
        )}
      </svg>
    </figure>
  );
}

export interface TileRows {
  principal: string;
  debt: string;
  apy: string;
  unlock: string;
}

const DASH = "—";
export const emptyRows: TileRows = { principal: DASH, debt: DASH, apy: DASH, unlock: DASH };

const STATUS_TEXT = { active: "Active", unlocked: "Unlocked", none: "No Position", soon: "Coming soon" } as const;

/** One Position (or the empty slot for a chain): status, the four figures, the chart, then actions. */
export function PositionTile({
  chain,
  status,
  rows,
  chartTitle,
  series,
  fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 3 }),
  children,
  label,
}: {
  chain: Chain;
  status: keyof typeof STATUS_TEXT;
  rows: TileRows;
  chartTitle: string;
  series: DebtSeries | null;
  fmt?: (n: number) => string;
  children?: ReactNode;
  label: string;
}) {
  return (
    <article className={`cut cut-card wl-tile ${status}`} aria-label={label}>
      <header>
        <span className="cut cut-chip wl-chain">{chain}</span>
        <span className="wl-status">
          {STATUS_TEXT[status]} <i aria-hidden="true" />
        </span>
      </header>
      <dl>
        <dt>Principal</dt>
        <dd className="tnum">{rows.principal}</dd>
        <dt>Debt</dt>
        <dd className="tnum">{rows.debt}</dd>
        <dt>Unlock Estimate</dt>
        <dd>{rows.unlock}</dd>
      </dl>
      <SimulatedYieldLabel />
      <div className="wl-actions">{children}</div>
      <details className="wl-more">
        <summary>Details</summary>
        <dl>
          <dt>APY</dt>
          <dd className="tnum">{rows.apy}</dd>
        </dl>
        <DebtChart title={chartTitle} series={series} fmt={fmt} />
      </details>
    </article>
  );
}
