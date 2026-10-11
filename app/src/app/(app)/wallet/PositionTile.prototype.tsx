"use client";

/**
 * PROTOTYPE ONLY: four takes on PositionTile, switched with ?variant=now|A|B|C|D (pink bar).
 * A Vault (Principal is the hero, Debt + Unlock as two cells with a sparkline), B Countdown (when the
 * Principal comes back, Debt burning down to zero across the card), C Ticket (two halves joined by a
 * perforation: what you locked | what you owe), D Track (where the Position is: Locked → Advance → Repaid →
 * Unlocked). Throwaway: the winner gets rewritten into PositionTile.tsx on main.
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode, useId } from "react";
import { Hourglass, Lock, LockOpen } from "lucide-react";
import { ChainGlyph, SimulatedYieldLabel } from "@/components/ui";
import type { Chain } from "@/lib/mock/types";
import type { DebtSeries, TileRows } from "./PositionTile";
import "./position-tile.prototype.css";

export const PT_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Vault" },
  { key: "B", name: "Countdown" },
  { key: "C", name: "Ticket" },
  { key: "D", name: "Track" },
] as const;
export type PtKey = (typeof PT_VARIANTS)[number]["key"];

export interface PtProps {
  chain: Chain;
  status: "active" | "unlocked" | "none" | "soon";
  rows: TileRows;
  chartTitle: string;
  series: DebtSeries | null;
  fmt: (n: number) => string;
  children?: ReactNode;
  label: string;
}

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const NAME = { SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM" } as const;

/** Actions vs the small notes the cards pass in (notes go behind Details in every variant). */
function split(children: ReactNode) {
  const actions: ReactNode[] = [];
  const notes: ReactNode[] = [];
  const walk = (n: ReactNode) =>
    Children.forEach(n, (c) => {
      if (isValidElement(c) && c.type === Fragment) return walk((c as ReactElement<{ children?: ReactNode }>).props.children);
      const cls = isValidElement(c) ? String((c.props as { className?: string }).className ?? "") : "";
      (cls.includes("wl-tile-note") ? notes : actions).push(c);
    });
  walk(children);
  return { actions, notes };
}

type Phase = "none" | "soon" | "idle" | "repaying" | "ready" | "unlocked";
function phaseOf(p: PtProps): Phase {
  if (p.status === "none" || p.status === "soon") return p.status;
  if (p.status === "unlocked") return "unlocked";
  if (p.rows.unlock === "No open Advance") return "idle";
  if (p.rows.debt === "0" || /^0(\s|$)/.test(p.rows.debt) || p.rows.unlock === "Debt is zero") return "ready";
  return "repaying";
}

/** "Oct 11, 17:02 (in ~12 min)" → when + rel; "1,377 Gemas · 0.55 SOL" → main + sub. */
const splitUnlock = (s: string) => {
  const m = s.match(/^(.*?)\s*\((.*)\)$/);
  return m ? { when: m[1], rel: m[2] } : { when: s, rel: "" };
};
const splitDebt = (s: string) => {
  const [main, sub] = s.split(" · ");
  return { main, sub: sub ?? "" };
};
const splitFig = (s: string) => {
  const m = s.match(/^([\d.,—-]+)\s*(.*)$/);
  return m ? { n: m[1], unit: m[2] } : { n: s, unit: "" };
};

function Spark({ series, h = 44, className }: { series: DebtSeries | null; h?: number; className?: string }) {
  const id = useId();
  if (!series) return null;
  const W = 240;
  const max = Math.max(...series.vals, 1e-9);
  const n = series.vals.length - 1;
  const pts = series.vals.map((v, i) => [(i / n) * W, 2 + (1 - v / max) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg className={`pt-spark ${className ?? ""}`} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${h}L0,${h}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StateTag({ phase }: { phase: Phase }) {
  const t = { none: "No Position", soon: "Coming soon", idle: "Locked", repaying: "Locked", ready: "Ready to unlock", unlocked: "Unlocked" }[phase];
  const Icon = phase === "unlocked" || phase === "ready" ? LockOpen : Lock;
  return (
    <span className={`cut cut-chip pt-tag ${phase}`}>
      {phase !== "none" && phase !== "soon" && <Icon size={13} strokeWidth={2.4} aria-hidden="true" />}
      {t}
    </span>
  );
}

function More({ apy, notes, series, chartTitle }: { apy: string; notes: ReactNode[]; series?: DebtSeries | null; chartTitle?: string }) {
  if (!notes.length && !series && apy === "—") return null;
  return (
    <details className="pt-more">
      <summary>Details</summary>
      <dl>
        <dt>Yield (APY)</dt>
        <dd>{apy}</dd>
      </dl>
      {series && chartTitle && (
        <div className="pt-more-chart">
          <span>{chartTitle} · projected</span>
          <Spark series={series} h={56} />
          <div className="pt-axis">{series.labels.map((l, i) => <span key={i}>{l}</span>)}</div>
        </div>
      )}
      {notes}
    </details>
  );
}

function Empty({ p, phase, actions, cls }: { p: PtProps; phase: Phase; actions: ReactNode[]; cls: string }) {
  return (
    <article className={`cut cut-card pt ${cls} pt-empty ${phase}`} aria-label={p.label}>
      <span className="cut pt-mark"><ChainGlyph asset={GLYPH[p.chain]} size={30} /></span>
      <div>
        <b>{phase === "soon" ? `${p.chain} Positions` : `No ${p.chain} Position`}</b>
        <small>{phase === "soon" ? `${NAME[p.chain]} · coming soon` : `Lock ${p.chain} on ${NAME[p.chain]} and take Gemas now`}</small>
      </div>
      {actions.length > 0 && <div className="pt-actions">{actions}</div>}
    </article>
  );
}

/* ——— A · Vault ——— */
function VariantA(p: PtProps) {
  const { actions, notes } = split(p.children);
  const phase = phaseOf(p);
  if (phase === "none" || phase === "soon") return <Empty p={p} phase={phase} actions={actions} cls="pt-a" />;
  const pr = splitFig(p.rows.principal);
  const d = splitDebt(p.rows.debt);
  const u = splitUnlock(p.rows.unlock);
  return (
    <article className={`cut cut-card pt pt-a ${phase}`} aria-label={p.label}>
      <header className="pt-a-head">
        <span className="cut pt-mark"><ChainGlyph asset={GLYPH[p.chain]} size={28} /></span>
        <div className="pt-name">
          <b>{p.chain} Position</b>
          <small>{NAME[p.chain]} · {p.rows.apy} yield</small>
        </div>
        <StateTag phase={phase} />
      </header>
      <div className="pt-a-principal">
        <span className="pt-k">Principal</span>
        <b className="pt-fig">{pr.n}<em>{pr.unit}</em></b>
        <small>{phase === "unlocked" ? "Back in your wallet" : "Locked. Never played."}</small>
      </div>
      {phase !== "unlocked" && <div className="pt-a-pair">
        <div className="cut pt-a-cell">
          <span className="pt-k">Debt</span>
          <b>{d.main}</b>
          {d.sub && <small>{d.sub}</small>}
          <Spark series={p.series} h={34} />
        </div>
        <div className="cut pt-a-cell">
          <span className="pt-k">Unlock Estimate</span>
          <b>{u.when}</b>
          {u.rel && <small><Hourglass size={12} aria-hidden="true" /> {u.rel}</small>}
        </div>
      </div>}
      <SimulatedYieldLabel />
      {actions.length > 0 && <div className="pt-actions">{actions}</div>}
      <More apy={p.rows.apy} notes={notes} />
    </article>
  );
}

/* ——— B · Countdown ——— */
function VariantB(p: PtProps) {
  const { actions, notes } = split(p.children);
  const phase = phaseOf(p);
  if (phase === "none" || phase === "soon") return <Empty p={p} phase={phase} actions={actions} cls="pt-b" />;
  const u = splitUnlock(p.rows.unlock);
  const d = splitDebt(p.rows.debt);
  const hero =
    phase === "repaying" ? (() => {
      const m = u.when.match(/^(.*), (\d{1,2}:\d{2})$/);
      return { k: "Principal back", big: m ? m[2] : u.when, rel: [m?.[1], u.rel || "as yield accrues"].filter(Boolean).join(" · ") };
    })()
    : phase === "ready" ? { k: "Principal back", big: "Now", rel: "Debt is zero: unlock any time" }
    : phase === "unlocked" ? { k: "Principal", big: "Returned", rel: "This Position is closed" }
    : { k: "Principal", big: "Locked", rel: "Take an Advance to get Gemas now" };
  return (
    <article className={`cut cut-card pt pt-b ${phase}`} aria-label={p.label}>
      <header className="pt-b-head">
        <ChainGlyph asset={GLYPH[p.chain]} size={20} />
        <b>{p.chain} Position</b>
        <span className="pt-b-lock">
          {phase === "unlocked" ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
          {p.rows.principal}
        </span>
      </header>
      <div className="pt-b-hero">
        <span className="pt-k">{hero.k}</span>
        <b className="pt-fig">{hero.big}</b>
        <small>{hero.rel}</small>
      </div>
      {p.series ? (
        <figure className="pt-b-burn">
          <figcaption><b>{d.main}</b> of Debt now · yield pays it to zero</figcaption>
          <Spark series={p.series} h={70} />
          <div className="pt-axis">{p.series.labels.map((l, i) => <span key={i}>{i === p.series!.labels.length - 1 ? `${l} · 0` : l}</span>)}</div>
        </figure>
      ) : (
        <div className="pt-b-flat"><span />{phase === "repaying" ? "Waiting for the first yield" : "No Debt"}</div>
      )}
      <dl className="pt-b-facts">
        <div><dt>Principal</dt><dd>{p.rows.principal}</dd></div>
        <div><dt>Debt</dt><dd>{d.main}{d.sub && <small>{d.sub}</small>}</dd></div>
        <div><dt>Yield</dt><dd>{p.rows.apy}</dd></div>
      </dl>
      <SimulatedYieldLabel />
      {actions.length > 0 && <div className="pt-actions">{actions}</div>}
      <More apy={p.rows.apy} notes={notes} />
    </article>
  );
}

/* ——— C · Ticket ——— */
function VariantC(p: PtProps) {
  const { actions, notes } = split(p.children);
  const phase = phaseOf(p);
  if (phase === "none" || phase === "soon") return <Empty p={p} phase={phase} actions={actions} cls="pt-c" />;
  const pr = splitFig(p.rows.principal);
  const d = splitDebt(p.rows.debt);
  const u = splitUnlock(p.rows.unlock);
  return (
    <article className={`cut cut-card pt pt-c ${phase}`} aria-label={p.label}>
      <div className="pt-c-body">
      <div className="pt-c-stub">
        <div className="pt-c-glyph" aria-hidden="true"><ChainGlyph asset={GLYPH[p.chain]} size={96} /></div>
        <span className="pt-k">{phase === "unlocked" ? "Unlocked" : "You locked"}</span>
        <b className="pt-fig">{pr.n}<em>{pr.unit}</em></b>
        <small>{NAME[p.chain]} · {p.rows.apy} yield</small>
        <StateTag phase={phase} />
      </div>
      <div className="pt-c-seam" aria-hidden="true" />
      <div className="pt-c-main">
        <span className="pt-k">{phase === "idle" ? "No Advance" : "Your Advance"}</span>
        <div className="pt-c-debt">
          <b>{phase === "idle" ? "None" : d.main}</b>
          <span>{phase === "idle" ? "Take an Advance to get Gemas now" : `Debt${d.sub ? ` · ${d.sub}` : ""}`}</span>
        </div>
        <Spark series={p.series} h={30} />
        <div className="pt-c-unlock">
          <Hourglass size={14} aria-hidden="true" />
          {phase === "repaying" ? (
            <span>Unlocks <b>{u.when}</b>{u.rel ? ` · ${u.rel}` : ""}</span>
          ) : (
            <span><b>{{ idle: "Earning yield", ready: "Debt is zero: unlock any time", unlocked: "Principal returned" }[phase as "idle"]}</b></span>
          )}
        </div>
      </div>
      </div>
      <footer className="pt-c-foot">
        <SimulatedYieldLabel />
        {actions.length > 0 && <div className="pt-actions">{actions}</div>}
        <More apy={p.rows.apy} notes={notes} />
      </footer>
    </article>
  );
}

/* ——— D · Track ——— */
const STOPS = ["Locked", "Advance", "Repaid", "Unlocked"] as const;
function VariantD(p: PtProps) {
  const { actions, notes } = split(p.children);
  const phase = phaseOf(p);
  if (phase === "none" || phase === "soon") return <Empty p={p} phase={phase} actions={actions} cls="pt-d" />;
  const d = splitDebt(p.rows.debt);
  const u = splitUnlock(p.rows.unlock);
  // index of the last reached stop; `live` = the leg after it is being worked on
  const at = { idle: 0, repaying: 1, ready: 2, unlocked: 3 }[phase];
  const live = phase === "repaying";
  const now =
    phase === "repaying" ? { t: "Yield is paying off your Debt", s: `${d.main} left${u.rel ? ` · done ${u.rel}` : ""}` }
    : phase === "ready" ? { t: "Debt is zero", s: "Unlock to get your Principal back" }
    : phase === "unlocked" ? { t: "Principal returned", s: "Collect any leftover yield" }
    : { t: "Earning yield", s: "No Advance taken on this Position" };
  return (
    <article className={`cut cut-card pt pt-d ${phase}`} aria-label={p.label}>
      <header className="pt-d-head">
        <span className="cut pt-mark"><ChainGlyph asset={GLYPH[p.chain]} size={24} /></span>
        <div className="pt-name">
          <b>{p.chain} Position</b>
          <small>{p.rows.apy} yield</small>
        </div>
        <div className="pt-d-principal">
          <span className="pt-k">Principal</span>
          <b>{p.rows.principal}</b>
        </div>
      </header>
      <ol className="pt-d-track" style={{ "--at": at } as React.CSSProperties}>
        {STOPS.map((s, i) => (
          <li key={s} className={i < at ? "done" : i === at ? "here" : ""}>
            <i aria-hidden="true" />
            <span>{s}</span>
          </li>
        ))}
        {live && <b className="pt-d-packet" aria-hidden="true" />}
      </ol>
      <div className="pt-d-now">
        <b>{now.t}</b>
        <span>{now.s}</span>
      </div>
      {live && <dl className="pt-d-figs">
        <div><dt>Debt</dt><dd>{d.main}{d.sub && <small>{d.sub}</small>}</dd></div>
        <div><dt>Unlock Estimate</dt><dd>{u.when}</dd></div>
      </dl>}
      <SimulatedYieldLabel />
      {actions.length > 0 && <div className="pt-actions">{actions}</div>}
      <More apy={p.rows.apy} notes={notes} series={p.series} chartTitle={p.chartTitle} />
    </article>
  );
}

export function PositionTileVariant({ variant, ...p }: PtProps & { variant: Exclude<PtKey, "now"> }) {
  const V = { A: VariantA, B: VariantB, C: VariantC, D: VariantD }[variant];
  return <V {...p} />;
}
