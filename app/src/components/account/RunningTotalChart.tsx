"use client";

import { useId, useState } from "react";
import type { PlayedRow } from "@/lib/chain/player-account";
import { signed } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";

type Point = { row: PlayedRow; total: number };

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** Tags near either end of the plot hang inward so they stay inside the panel. */
const edge = (pct: number) => (pct < 14 ? "start" : pct > 86 ? "end" : undefined);

/**
 * Gemas won and lost, added up Match by Match: a step per Match in the order the Matches were opened,
 * emerald above zero and red below it. The peak, the low and the latest total are marked; the pointer
 * (or the arrow keys) reads any Match into the caption.
 */
export function RunningTotalChart({ series, showGame }: { series: Point[]; showGame: boolean }) {
  const [at, setAt] = useState<number | null>(null);
  const id = useId().replace(/[^\w-]/g, "");
  const n = series.length;
  const totals = series.map((p) => p.total);
  const hi = Math.max(0, ...totals);
  const lo = Math.min(0, ...totals);
  const span = hi - lo || 1;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => ((hi - v) / span) * 100;
  const zero = y(0);

  // Flat until a Match settles, then straight up or down to the new total.
  let line = `M0,${zero}`;
  series.forEach((p, i) => (line += ` H${x(i)} V${y(p.total)}`));
  line += " H100";
  const area = `${line} V${zero} Z`;

  const peakI = totals.indexOf(Math.max(...totals));
  const lowI = totals.indexOf(Math.min(...totals));
  const last = series[n - 1];
  const read = at === null ? null : series[at];
  const move = (clientX: number, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setAt(Math.min(n - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * n))));
  };

  return (
    <figure className="pa-chart">
      <figcaption>
        <span>Running total</span>
        <span className="pa-read" role="status">
          {read && at !== null ? (
            <>
              Match {at + 1} of {n}
              {showGame && ` · ${GAME_NAMES[read.row.game]}`} · {day(read.row.at)} ·{" "}
              <span className={read.row.result === "won" ? "pa-won" : "pa-lost"}>
                {read.row.result === "won" ? "Won" : "Lost"} {signed(read.row.delta)}
              </span>
              <span className="sr-only">, total {signed(read.total)}</span>
            </>
          ) : (
            "Point at a step to see that Match"
          )}
        </span>
      </figcaption>
      <div
        className="pa-plot"
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
          aria-label={`Gemas won and lost over ${n} Matches: now ${signed(last.total)}, highest ${signed(totals[peakI])}, lowest ${signed(totals[lowI])}.`}
        >
          <defs>
            <linearGradient id={`${id}-up`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--em)" stopOpacity="0.3" />
              <stop offset="1" stopColor="var(--em)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${id}-down`} x1="0" x2="0" y1="1" y2="0">
              <stop offset="0" stopColor="var(--danger)" stopOpacity="0.3" />
              <stop offset="1" stopColor="var(--danger)" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${id}-above`}>
              <rect x="0" y="0" width="100" height={zero} />
            </clipPath>
            <clipPath id={`${id}-below`}>
              <rect x="0" y={zero} width="100" height={100 - zero} />
            </clipPath>
          </defs>
          <path d={area} fill={`url(#${id}-up)`} clipPath={`url(#${id}-above)`} />
          <path d={area} fill={`url(#${id}-down)`} clipPath={`url(#${id}-below)`} />
          <line x1={0} x2={100} y1={zero} y2={zero} className="zero" />
          <path d={line} className="line" />
        </svg>
        <span className="pa-zero" style={{ top: `${zero}%` }}>
          0
        </span>
        {at === null && totals[peakI] > 0 && peakI !== n - 1 && (
          <span className="pa-mark peak" data-edge={edge(x(peakI))} style={{ left: `${x(peakI)}%`, top: `${y(totals[peakI])}%` }}>
            Peak {signed(totals[peakI])}
          </span>
        )}
        {at === null && totals[lowI] < 0 && lowI !== n - 1 && (
          <span className="pa-mark low" data-edge={edge(x(lowI))} style={{ left: `${x(lowI)}%`, top: `${y(totals[lowI])}%` }}>
            Low {signed(totals[lowI])}
          </span>
        )}
        <span className="pa-end" style={{ top: `${y(last.total)}%` }}>
          {signed(last.total)}
        </span>
        {read && at !== null && (
          <>
            <i className="pa-cross" style={{ left: `${x(at)}%` }} />
            <i className="pa-dot" style={{ left: `${x(at)}%`, top: `${y(read.total)}%` }} />
            <span className="pa-val" data-edge={edge(x(at))} style={{ left: `${x(at)}%`, top: `${y(read.total)}%` }}>
              {signed(read.total)}
            </span>
          </>
        )}
      </div>
      <div className="pa-x" aria-hidden="true">
        <span>{day(series[0].row.at)}</span>
        <span>{n} Matches</span>
        <span>{day(last.row.at) === day(series[0].row.at) ? "" : day(last.row.at)}</span>
      </div>
    </figure>
  );
}
