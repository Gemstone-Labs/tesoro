"use client";

/**
 * PROTOTYPE ONLY (branch proto/gemas-panel-11-10-2026). Four takes on the Account page's
 * "Gemas won and lost" panel, switchable with `?variant=now|A|B|C|D`:
 *   now  the current panel (net, won/lost, neutral step line)
 *   A    Lit curve: same layout refined (split bar, area, peak + end marked, dates on the axis)
 *   B    Match by Match: one column per Match's result, form pips and records under it
 *   C    Where it came from: tiles, net per game, best win and biggest loss, a sparkline only
 *   D    Scrub: the curve fills the panel and the big figure reads whatever Match you point at
 * Throwaway: no tests, the winner gets rewritten into AccountView / RunningTotalChart.
 */
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { GemaMark, Label } from "@/components/ui";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import type { PlayedRow, PlayerSummary } from "@/lib/chain/player-account";
import { signed } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { RunningTotalChart } from "./RunningTotalChart";
import "./gemas-panel.prototype.css";

type Series = { row: PlayedRow; total: number }[];
type Props = { s: PlayerSummary; series: Series };

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Lit curve" },
  { key: "B", name: "Match by Match" },
  { key: "C", name: "Where it came from" },
  { key: "D", name: "Scrub" },
] as const;

export function GemasPanelPrototype(props: Props) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && <Now {...props} />}
      {v === "A" && <VariantA {...props} />}
      {v === "B" && <VariantB {...props} />}
      {v === "C" && <VariantC {...props} />}
      {v === "D" && <VariantD {...props} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/* ——— shared bits ——— */

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function facts(series: Series) {
  const totals = series.map((p) => p.total);
  const deltas = series.map((p) => p.row.delta);
  const argmax = (xs: number[]) => xs.reduce((b, x, i) => (x > xs[b] ? i : b), 0);
  const argmin = (xs: number[]) => xs.reduce((b, x, i) => (x < xs[b] ? i : b), 0);
  let streak = 0;
  let run = 0;
  for (const p of series) {
    run = p.row.result === "won" ? run + 1 : 0;
    streak = Math.max(streak, run);
  }
  const wins = series.filter((p) => p.row.result === "won").length;
  return {
    n: series.length,
    wins,
    losses: series.length - wins,
    peakI: argmax(totals),
    lowI: argmin(totals),
    bestI: argmax(deltas),
    worstI: argmin(deltas),
    streak,
  };
}

function byGame(series: Series) {
  const m = new Map<GameId, { game: GameId; net: number; won: number; lost: number; matches: number }>();
  for (const { row } of series) {
    const g = m.get(row.game) ?? { game: row.game, net: 0, won: 0, lost: 0, matches: 0 };
    g.net += row.delta;
    g.matches += 1;
    if (row.delta >= 0) g.won += row.delta;
    else g.lost -= row.delta;
    m.set(row.game, g);
  }
  return [...m.values()].sort((a, b) => b.net - a.net);
}

/** Pointer + arrow keys over a plot of n points; null when nothing is read. */
function useScrub(n: number) {
  const [at, setAt] = useState<number | null>(null);
  const move = (clientX: number, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setAt(Math.min(n - 1, Math.max(0, Math.floor(((clientX - box.left) / box.width) * n))));
  };
  const handlers = {
    tabIndex: 0,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => move(e.clientX, e.currentTarget),
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => move(e.clientX, e.currentTarget),
    onPointerLeave: () => setAt(null),
    onBlur: () => setAt(null),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setAt((i) => Math.min(n - 1, Math.max(0, (i ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
    },
  };
  return { at, handlers };
}

/** Running total as an area: x = Match index (point at the middle of its slot), y scaled to [lo, hi]. */
function curve(series: Series, smooth: boolean) {
  const n = series.length;
  const totals = series.map((p) => p.total);
  const hi = Math.max(0, ...totals);
  const lo = Math.min(0, ...totals);
  const span = hi - lo || 1;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => ((hi - v) / span) * 100;
  let line = `M0,${y(0)}`;
  if (smooth) series.forEach((p, i) => (line += ` L${x(i)},${y(p.total)}`));
  else series.forEach((p, i) => (line += ` H${x(i)} V${y(p.total)}`));
  line += ` H100`;
  const area = `${line} V${y(0)} Z`;
  return { x, y, hi, lo, line, area, zero: y(0) };
}

function AreaSvg({ series, smooth, id }: { series: Series; smooth: boolean; id: string }) {
  const c = curve(series, smooth);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-up`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--em)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--em)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-down`} x1="0" x2="0" y1="1" y2="0">
          <stop offset="0" stopColor="var(--danger)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--danger)" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-above`}><rect x="0" y="0" width="100" height={c.zero} /></clipPath>
        <clipPath id={`${id}-below`}><rect x="0" y={c.zero} width="100" height={100 - c.zero} /></clipPath>
      </defs>
      <path d={c.area} fill={`url(#${id}-up)`} clipPath={`url(#${id}-above)`} />
      <path d={c.area} fill={`url(#${id}-down)`} clipPath={`url(#${id}-below)`} />
      <line x1={0} x2={100} y1={c.zero} y2={c.zero} className="gx-zero" />
      <path d={c.line} className="gx-line" />
    </svg>
  );
}

function MatchLine({ p, i, n }: { p: Series[number]; i: number; n: number }) {
  return (
    <>
      Match {i + 1} of {n} · {GAME_NAMES[p.row.game]} · {day(p.row.at)} ·{" "}
      <span className={p.row.result === "won" ? "gx-won" : "gx-lost"}>
        {p.row.result === "won" ? "Won" : "Lost"} {signed(p.row.delta)}
      </span>
    </>
  );
}

/* ——— now: the current panel ——— */

function Now({ s, series }: Props) {
  return (
    <section className="cut cut-card pa-panel pa-gemas" aria-label="Gemas won and lost">
      <Label>Gemas won and lost</Label>
      <b className="pa-big">
        <GemaMark size={34} />
        {signed(s.net)}
      </b>
      <dl className="pa-split">
        <div>
          <dt>Won</dt>
          <dd>{signed(s.won)}</dd>
        </div>
        <div>
          <dt>Lost</dt>
          <dd>{signed(-s.lost)}</dd>
        </div>
        <p>After Fees</p>
      </dl>
      {series.length >= 2 && <RunningTotalChart series={series} />}
    </section>
  );
}

/* ——— A: Lit curve ——— */

function VariantA({ s, series }: Props) {
  const f = facts(series);
  const c = curve(series, false);
  const { at, handlers } = useScrub(f.n);
  const last = series[f.n - 1];
  const peak = series[f.peakI];
  const read = at === null ? null : series[at];
  const share = s.won + s.lost === 0 ? 0.5 : s.won / (s.won + s.lost);
  return (
    <section className="cut cut-card pa-panel pa-gemas gx-a" aria-label="Gemas won and lost">
      <Label>Gemas won and lost</Label>
      <div className="gx-a-head">
        <b className="pa-big">
          <GemaMark size={34} />
          {signed(s.net)}
        </b>
        <p className="gx-sub">net after Fees, over {f.n} Matches</p>
      </div>

      <div className="gx-a-split">
        <div className="gx-a-split-labels">
          <span><small>Won · {f.wins} Matches</small><b className="gx-won">{signed(s.won)}</b></span>
          <span><small>Lost · {f.losses} Matches</small><b className="gx-lost">{signed(-s.lost)}</b></span>
        </div>
        <span className="gx-a-bar" aria-hidden="true">
          <i style={{ width: `${share * 100}%` }} />
        </span>
      </div>

      {f.n >= 2 && (
        <figure className="gx-a-chart">
          <figcaption>
            <span>Running total</span>
            <span className="gx-a-read" role="status">{read && at !== null ? <MatchLine p={read} i={at} n={f.n} /> : "Point at a step to read the Match"}</span>
          </figcaption>
          <div className="gx-a-plot" {...handlers} role="group" aria-label={`Running total over ${f.n} Matches. Arrow keys read each Match.`}>
            <AreaSvg series={series} smooth={false} id="gxa" />
            <span className="gx-a-tag" hidden={at !== null} style={{ left: `${c.x(f.peakI)}%`, top: `${c.y(peak.total)}%` }}>
              <i /> Peak {signed(peak.total)}
            </span>
            <span className="gx-a-end" style={{ top: `${c.y(last.total)}%` }}>
              <i /> {signed(last.total)}
            </span>
            {read && at !== null && (
              <>
                <i className="gx-cross" style={{ left: `${c.x(at)}%` }} />
                <i className="gx-dot" style={{ left: `${c.x(at)}%`, top: `${c.y(read.total)}%` }} />
                <span className="gx-a-val" style={{ left: `${c.x(at)}%`, top: `${c.y(read.total)}%` }}>{signed(read.total)}</span>
              </>
            )}
            <span className="gx-a-zero" style={{ top: `${c.zero}%` }}>0</span>
          </div>
          <div className="gx-a-x">
            <span>{day(series[0].row.at)}</span>
            <span>{f.n} Matches</span>
            <span>{day(last.row.at)}</span>
          </div>
        </figure>
      )}
    </section>
  );
}

/* ——— B: Match by Match ——— */

function VariantB({ s, series }: Props) {
  const f = facts(series);
  const { at, handlers } = useScrub(f.n);
  const deltas = series.map((p) => p.row.delta);
  const up = Math.max(1, ...deltas);
  const down = Math.max(1, ...deltas.map((d) => -d));
  const zero = (up / (up + down)) * 100;
  const read = at === null ? null : series[at];
  const spark = curve(series, true);
  const recent = series.slice(-10);
  return (
    <section className="cut cut-card pa-panel pa-gemas gx-b" aria-label="Gemas won and lost">
      <div className="gx-b-head">
        <div>
          <Label>Gemas won and lost</Label>
          <b className="pa-big">
            <GemaMark size={34} />
            {signed(s.net)}
          </b>
          <p className="gx-sub">
            <span className="gx-won">{signed(s.won)}</span> won · <span className="gx-lost">{signed(-s.lost)}</span> lost · after Fees
          </p>
        </div>
        <svg className="gx-b-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={spark.line} className="gx-line" />
        </svg>
      </div>

      <figure className="gx-b-chart">
        <figcaption role="status">{read && at !== null ? <MatchLine p={read} i={at} n={f.n} /> : <>Each column is one Match, oldest on the left</>}</figcaption>
        <div className="gx-b-plot" {...handlers} role="group" aria-label={`${f.n} Match results. Arrow keys read each Match.`}>
          <i className="gx-b-axis" style={{ top: `${zero}%` }} />
          {series.map((p, i) => {
            const d = p.row.delta;
            const h = d >= 0 ? (d / up) * zero : (-d / down) * (100 - zero);
            return (
              <i
                key={p.row.id}
                className={`gx-b-col ${d >= 0 ? "up" : "down"}${at === i ? " on" : ""}${at !== null && at !== i ? " dim" : ""}`}
                style={{ left: `${(i / f.n) * 100}%`, width: `${100 / f.n}%`, top: d >= 0 ? `${zero - h}%` : `${zero}%`, height: `${Math.max(h, 0.8)}%` }}
              />
            );
          })}
        </div>
      </figure>

      <div className="gx-b-foot">
        <div className="gx-b-form">
          <small>Last {recent.length}</small>
          <span>
            {recent.map((p) => (
              <i key={p.row.id} className={`gx-pip ${p.row.result === "won" ? "w" : "l"}`} title={`${GAME_NAMES[p.row.game]} · ${signed(p.row.delta)}`}>
                {p.row.result === "won" ? "W" : "L"}
              </i>
            ))}
          </span>
        </div>
        <dl className="gx-b-rec">
          <div><dt>Best win</dt><dd className="gx-won">{signed(series[f.bestI].row.delta)}</dd></div>
          <div><dt>Biggest loss</dt><dd className="gx-lost">{signed(series[f.worstI].row.delta)}</dd></div>
          <div><dt>Best streak</dt><dd>{f.streak} wins</dd></div>
        </dl>
      </div>
    </section>
  );
}

/* ——— C: Where it came from ——— */

function VariantC({ s, series }: Props) {
  const f = facts(series);
  const games = byGame(series);
  const most = Math.max(1, ...games.map((g) => Math.abs(g.net)));
  const spark = curve(series, true);
  const best = series[f.bestI];
  const worst = series[f.worstI];
  return (
    <section className="cut cut-card pa-panel pa-gemas gx-c" aria-label="Gemas won and lost">
      <Label>Gemas won and lost</Label>
      <div className="gx-c-head">
        <div>
          <b className="pa-big">
            <GemaMark size={34} />
            {signed(s.net)}
          </b>
          <p className="gx-sub">net after Fees · peak {signed(series[f.peakI].total)}</p>
        </div>
        <svg className="gx-c-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1={0} x2={100} y1={spark.zero} y2={spark.zero} className="gx-zero" />
          <path d={spark.line} className="gx-line" />
        </svg>
      </div>

      <div className="gx-c-tiles">
        <div className="cut cut-card gx-c-tile">
          <small>Won</small>
          <b className="gx-won">{signed(s.won)}</b>
          <span>in {f.wins} Matches</span>
        </div>
        <div className="cut cut-card gx-c-tile">
          <small>Lost</small>
          <b className="gx-lost">{signed(-s.lost)}</b>
          <span>in {f.losses} Matches</span>
        </div>
      </div>

      <div className="gx-c-games">
        <h4>By game</h4>
        {games.map((g) => (
          <div key={g.game} className="gx-c-game">
            <Image src={art.thumb[g.game]} alt="" width={40} height={40} className="gx-c-thumb" />
            <span className="gx-c-name">
              <b>{GAME_NAMES[g.game]}</b>
              <small>{g.matches} Matches</small>
            </span>
            <span className="gx-c-track" aria-hidden="true">
              <i className={g.net >= 0 ? "up" : "down"} style={{ width: `${(Math.abs(g.net) / most) * 50}%` }} />
            </span>
            <b className={g.net >= 0 ? "gx-won" : "gx-lost"}>{signed(g.net)}</b>
          </div>
        ))}
      </div>

      <div className="gx-c-big">
        <Link href={`/play/match/${best.row.id}`} className="gx-c-big-row">
          <small>Best win</small>
          <span>{GAME_NAMES[best.row.game]} · {day(best.row.at)}</span>
          <b className="gx-won">{signed(best.row.delta)}</b>
        </Link>
        <Link href={`/play/match/${worst.row.id}`} className="gx-c-big-row">
          <small>Biggest loss</small>
          <span>{GAME_NAMES[worst.row.game]} · {day(worst.row.at)}</span>
          <b className="gx-lost">{signed(worst.row.delta)}</b>
        </Link>
      </div>
    </section>
  );
}

/* ——— D: Scrub ——— */

const RANGES = [
  { key: "all", label: "All", take: Infinity },
  { key: "20", label: "Last 20", take: 20 },
  { key: "10", label: "Last 10", take: 10 },
] as const;

function VariantD({ s, series: all }: Props) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const take = RANGES.find((r) => r.key === range)!.take;
  const offset = Math.max(0, all.length - take);
  const base = offset > 0 ? all[offset - 1].total : 0;
  // A window starts from zero: its curve is what those Matches added, not the lifetime total.
  const series = all.slice(offset).map((p) => ({ ...p, total: p.total - base }));
  const f = facts(series);
  const c = curve(series, true);
  const { at, handlers } = useScrub(f.n);
  const read = at === null ? null : series[at];
  const shown = read ? read.total : series[f.n - 1].total;
  const won = series.reduce((a, p) => a + Math.max(0, p.row.delta), 0);
  const lost = series.reduce((a, p) => a + Math.max(0, -p.row.delta), 0);
  return (
    <section className="cut cut-card pa-panel pa-gemas gx-d" aria-label="Gemas won and lost">
      <div className="gx-d-head">
        <div>
          <Label>Gemas won and lost</Label>
          <b className="pa-big gx-d-big" aria-live="polite">
            <GemaMark size={34} />
            {signed(shown)}
          </b>
          <p className="gx-sub">
            {read && at !== null ? <MatchLine p={read} i={at} n={f.n} /> : <>{range === "all" ? "All time" : `Last ${f.n} Matches`} · after Fees · point at the curve to go back</>}
          </p>
        </div>
        <div className="gx-d-range" role="radiogroup" aria-label="Matches shown">
          {RANGES.filter((r) => r.take === Infinity || r.take < all.length).map((r) => (
            <button key={r.key} type="button" role="radio" aria-checked={range === r.key} className={`cut cut-chip${range === r.key ? " on" : ""}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="gx-d-plot" {...handlers} role="group" aria-label={`Running total over ${f.n} Matches. Arrow keys read each Match.`}>
        <AreaSvg series={series} smooth id="gxd" />
        <i className="gx-d-peak" style={{ left: `${c.x(f.peakI)}%`, top: `${c.y(series[f.peakI].total)}%` }} title={`Peak ${signed(series[f.peakI].total)}`} />
        {read && at !== null ? (
          <>
            <i className="gx-cross" style={{ left: `${c.x(at)}%` }} />
            <i className="gx-dot" style={{ left: `${c.x(at)}%`, top: `${c.y(read.total)}%` }} />
          </>
        ) : (
          <i className="gx-dot gx-pulse" style={{ left: `${c.x(f.n - 1)}%`, top: `${c.y(series[f.n - 1].total)}%` }} />
        )}
      </div>

      <dl className="gx-d-strip">
        <div><dt>Won</dt><dd className="gx-won">{signed(range === "all" ? s.won : won)}</dd></div>
        <div><dt>Lost</dt><dd className="gx-lost">{signed(-(range === "all" ? s.lost : lost))}</dd></div>
        <div><dt>Peak</dt><dd>{signed(series[f.peakI].total)}</dd></div>
        <div><dt>Matches</dt><dd>{f.wins} W · {f.losses} L</dd></div>
      </dl>
    </section>
  );
}
