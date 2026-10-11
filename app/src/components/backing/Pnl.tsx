"use client";

import { useId } from "react";
import { signed } from "@/lib/chain/player-account";
import { GemaMark } from "@/components/ui";
import "./pnl.css";

/** The Player's P&L: the net figure, and the running total Match by Match, emerald above zero and red below. */
export function Pnl({ deltas }: { deltas: number[] }) {
  const id = useId().replace(/[^\w-]/g, "");
  const totals = deltas.reduce<number[]>((acc, d) => [...acc, (acc.at(-1) ?? 0) + d], []);
  const net = totals.at(-1) ?? 0;
  const W = 240;
  const H = 44;
  const hi = Math.max(0, ...totals);
  const lo = Math.min(0, ...totals);
  const span = hi - lo || 1;
  const x = (i: number) => ((i + 1) / totals.length) * W;
  const y = (v: number) => 2 + ((hi - v) / span) * (H - 4);
  const zero = y(0);
  const line = `M0,${zero}` + totals.map((v, i) => ` H${x(i)} V${y(v)}`).join("");
  return (
    <div className="pnl">
      <div className="pnl-head">
        <span>P&amp;L</span>
        <b className={net > 0 ? "up" : net < 0 ? "down" : undefined}>
          <GemaMark size={16} />
          {signed(net)}
          <span className="sr-only"> Gemas over {deltas.length} Matches</span>
        </b>
      </div>
      {totals.length > 0 && (
        <svg className="pnl-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={`${id}-up`}>
              <rect width={W} height={zero} />
            </clipPath>
            <clipPath id={`${id}-down`}>
              <rect y={zero} width={W} height={H - zero} />
            </clipPath>
          </defs>
          <line x2={W} y1={zero} y2={zero} className="zero" />
          {(["up", "down"] as const).map((side) => (
            <g key={side} className={side} clipPath={`url(#${id}-${side})`}>
              <path d={`${line} V${zero} Z`} className="area" />
              <path d={line} className="ln" />
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
