"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FILL, SIDE, type Asset, type Fill } from "./chain";
import type { Point } from "./feed";
import { usd } from "./fmt";

const PAD = { l: 12, r: 84, t: 16, b: 26 };

export interface ChartProps {
  asset: Asset;
  series: Point[];
  /** Left edge of the window, ms. */
  from: number;
  /** Right edge of the window, ms. */
  to: number;
  /** Trading opens at this ms; drawn as a rule. */
  startsAt: number;
  fills: Fill[];
  /** ms trading opened, the origin of each fill's `t`. */
  origin: number;
  /** Open position lines (USD). */
  entry?: { price: number; side: number } | null;
  liquidation?: number | null;
  now: number;
}

/** The live price as a line over the Match window, with the Player's own fills marked. Colours: sapphire up, amber down, never green or red. */
export function Chart({ asset, series, from, to, startsAt, fills, origin, entry, liquidation, now }: ChartProps) {
  // Drawn at the real pixel size so the labels stay readable on a phone.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 340 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const w = Math.max(280, Math.round(el.clientWidth));
      setSize((cur) => (cur.w === w ? cur : { w, h: w < 520 ? 250 : 340 }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w: W, h: H } = size;

  const g = useMemo(() => {
    const pts = series.filter((p) => p.t >= from && p.t <= to);
    const marks = fills.map((f) => ({ f, t: origin + f.t * 1000, p: Number(f.price) / 1e8 }));
    const prices = [...pts.map((p) => p.p), ...marks.map((m) => m.p)];
    if (entry) prices.push(entry.price);
    if (!prices.length) return null;
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    const mid = (lo + hi) / 2;
    const minSpan = mid * 0.0008;
    if (hi - lo < minSpan) {
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    const x = (t: number) => PAD.l + ((t - from) / Math.max(1, to - from)) * (W - PAD.l - PAD.r);
    const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ");
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const digits = hi - lo < 0.1 ? 4 : hi - lo < 1 ? 3 : 2;
    return { pts, marks, path, ticks, x, y, lo, hi, digits, last: pts[pts.length - 1] };
  }, [series, from, to, fills, origin, entry, W, H]);

  if (!g) return <div ref={box} className="td-chart-empty meta" role="status">Waiting for the first live price…</div>;
  const nowX = Math.min(Math.max(g.x(now), PAD.l), W - PAD.r);
  const startX = g.x(startsAt);
  const entryColor = entry?.side === SIDE.short ? "var(--down)" : "var(--up)";

  const liqIn = liquidation && liquidation > g.lo && liquidation < g.hi ? liquidation : null;
  const px = (v: number) => usd(v, asset, g.digits);

  return (
    <div ref={box}>
    <svg className="td-chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${asset.symbol} price over the Match, ${g.last ? usd(g.last.p, asset) : "no price yet"}`}>
      {g.ticks.map((tk) => (
        <g key={tk}>
          <line x1={PAD.l} x2={W - PAD.r} y1={g.y(tk)} y2={g.y(tk)} className="td-grid" />
          <text x={W - PAD.r + 8} y={g.y(tk) + 4} className="td-axis">{px(tk)}</text>
        </g>
      ))}
      {startX > PAD.l && startX < W - PAD.r && (
        <g>
          <line x1={startX} x2={startX} y1={PAD.t} y2={H - PAD.b} className="td-rule" />
          <text x={startX + 6} y={H - 8} className="td-axis">Trading opens</text>
        </g>
      )}
      <line x1={nowX} x2={nowX} y1={PAD.t} y2={H - PAD.b} className="td-now" />
      {entry && <line x1={PAD.l} x2={W - PAD.r} y1={g.y(entry.price)} y2={g.y(entry.price)} stroke={entryColor} className="td-level" />}
      {entry && <text x={PAD.l + 4} y={g.y(entry.price) - 5} fill={entryColor} className="td-axis">Entry {px(entry.price)}</text>}
      {liqIn ? <line x1={PAD.l} x2={W - PAD.r} y1={g.y(liqIn)} y2={g.y(liqIn)} className="td-level td-liq" /> : null}
      {liqIn ? <text x={PAD.l + 4} y={g.y(liqIn) - 5} className="td-axis td-liq-t">Liquidation {px(liqIn)}</text> : null}
      {liquidation && !liqIn ? <text x={PAD.l + 4} y={H - PAD.b - 6} className="td-axis td-liq-t">Liquidation {px(liquidation)} {liquidation < g.lo ? "\u25BC below" : "\u25B2 above"}</text> : null}
      <path d={g.path} className="td-line" fill="none" />
      {g.marks.map((m, i) => {
        const cx = g.x(m.t);
        const cy = g.y(m.p);
        if (cx < PAD.l || cx > W - PAD.r) return null;
        if (m.f.kind === FILL.open) {
          const up = m.f.side === SIDE.long;
          return <path key={i} d={up ? `M${cx},${cy - 9} L${cx + 8},${cy + 6} L${cx - 8},${cy + 6} Z` : `M${cx},${cy + 9} L${cx + 8},${cy - 6} L${cx - 8},${cy - 6} Z`} fill={up ? "var(--up)" : "var(--down)"} className="td-mark" />;
        }
        if (m.f.kind === FILL.liquidated) {
          return <path key={i} d={`M${cx - 7},${cy - 7} L${cx + 7},${cy + 7} M${cx + 7},${cy - 7} L${cx - 7},${cy + 7}`} className="td-mark-x" />;
        }
        return <path key={i} d={`M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} Z`} className="td-mark-close" />;
      })}
      {g.last && (
        <g>
          <circle cx={g.x(g.last.t)} cy={g.y(g.last.p)} r="4.5" className="td-dot" />
          <text x={W - PAD.r + 8} y={g.y(g.last.p) + 4} className="td-axis td-axis-now">{px(g.last.p)}</text>
        </g>
      )}
    </svg>
    </div>
  );
}
