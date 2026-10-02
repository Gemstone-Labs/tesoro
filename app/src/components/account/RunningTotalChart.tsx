"use client";

import { useState } from "react";
import type { PlayedRow } from "@/lib/chain/player-account";
import { signed } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";

/**
 * Gemas won and lost, added up Match by Match: one neutral step line around a zero baseline.
 * Each step is one Match, in the order the Matches were opened. The pointer (or the arrow keys)
 * reads any Match; the Match history below lists the same numbers.
 */
export function RunningTotalChart({ series }: { series: { row: PlayedRow; total: number }[] }) {
  const [at, setAt] = useState<number | null>(null);
  const n = series.length;
  const totals = series.map((p) => p.total);
  const hi = Math.max(0, ...totals);
  const lo = Math.min(0, ...totals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / n) * 100;
  const y = (v: number) => ((hi - v) / span) * 100;

  // Flat until a Match settles, then straight up or down to the new total.
  let path = `M0,${y(0)}`;
  series.forEach((p, i) => (path += ` H${x(i + 1)} V${y(p.total)}`));

  const last = totals[n - 1];
  const ticks = [...new Set([hi, 0, lo])];
  const point = at === null ? null : series[at];
  const move = (clientX: number, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setAt(Math.min(n - 1, Math.max(0, Math.round(((clientX - box.left) / box.width) * n) - 1)));
  };

  return (
    <figure className="pa-chart">
      <figcaption>Running total, Match by Match in the order they were opened</figcaption>
      <div className="pa-plot">
        {ticks.map((t) => (
          <span key={t} className="pa-tick" style={{ top: `${y(t)}%` }}>
            {signed(t)}
          </span>
        ))}
        <div
          className="pa-area"
          tabIndex={0}
          role="group"
          aria-label={`Running total over ${n} Matches. Use the arrow keys to read each Match.`}
          onPointerMove={(e) => move(e.clientX, e.currentTarget)}
          onPointerDown={(e) => move(e.clientX, e.currentTarget)}
          onPointerLeave={() => setAt(null)}
          onFocus={() => setAt((i) => i ?? n - 1)}
          onBlur={() => setAt(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            setAt((i) => Math.min(n - 1, Math.max(0, (i ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
          }}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Gemas won and lost over ${n} Matches: now ${signed(last)}, highest ${signed(Math.max(...totals))}, lowest ${signed(Math.min(...totals))}.`}
          >
            {ticks.map((t) => (
              <line key={t} x1={0} x2={100} y1={y(t)} y2={y(t)} className={t === 0 ? "zero" : "grid"} />
            ))}
            <path d={path} className="line" />
          </svg>
          {point && at !== null && (
            <>
              <i className="pa-cross" style={{ left: `${x(at + 1)}%` }} />
              <i className="pa-dot" style={{ left: `${x(at + 1)}%`, top: `${y(point.total)}%` }} />
            </>
          )}
          <span className="pa-end" style={{ top: `${y(last)}%` }}>
            {signed(last)}
          </span>
        </div>
        <p className={`pa-tip${point ? " on" : ""}`} role="status" style={at === null ? undefined : { left: `${x(at + 1)}%` }} data-side={at !== null && at + 1 > n / 2 ? "left" : "right"}>
          {point && at !== null && (
            <>
              <b>{signed(point.total)} Gemas</b>
              <span>
                Match {at + 1} of {n} · {GAME_NAMES[point.row.game]} · {point.row.result === "won" ? "Won" : "Lost"} {signed(point.row.delta)}
              </span>
            </>
          )}
        </p>
      </div>
    </figure>
  );
}
