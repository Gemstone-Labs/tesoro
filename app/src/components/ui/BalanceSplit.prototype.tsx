"use client";

/**
 * PROTOTYPE ONLY (branch proto/balance-split-11-10-2026). Four takes on BalanceSplit, switched by
 * `?variant=now|A|B|C|D`:
 *   A Scale bar — one card, both amounts on one bar drawn to scale, each figure under its segment
 *   B Ledger    — two rows like a statement: icon, label and note left, figure right
 *   C Flow      — Pending (hatched, waiting) flows into Redeemable now (lit) as yield lands
 *   D Lead      — Redeemable now as the big faceted figure, Pending as a quieter line under a rule
 * The winner gets rewritten into money.tsx; this file never lands on main.
 */
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import { GemaMark } from "./gema";
import { ArrowIcon, CheckIcon, ClockIcon } from "./icons";
import "./balance-split.prototype.css";

export const BALANCE_SPLIT_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Scale bar" },
  { key: "B", name: "Ledger" },
  { key: "C", name: "Flow" },
  { key: "D", name: "Lead" },
] as const;
export type BalanceSplitVariant = (typeof BALANCE_SPLIT_VARIANTS)[number]["key"];

export interface SplitProps {
  redeemable: number;
  pending: number;
  redeemableSources?: number;
}

type Css = React.CSSProperties & Record<`--${string}`, string | number>;

const sources = (n?: number) => (n ? `${n} Source${n === 1 ? "" : "s"}` : "");
const usd = (n: number) => `≈ ${fmtUsd(gemasToUsd(n))}`;
const share = (p: SplitProps) => {
  const total = p.redeemable + p.pending;
  return total > 0 ? p.redeemable / total : 0;
};

export function BalanceSplitPrototype({ variant, ...p }: SplitProps & { variant: Exclude<BalanceSplitVariant, "now"> }) {
  if (variant === "A") return <ScaleBar {...p} />;
  if (variant === "B") return <Ledger {...p} />;
  if (variant === "C") return <Flow {...p} />;
  return <Lead {...p} />;
}

/* A — one bar to scale */
function ScaleBar(p: SplitProps) {
  const s = share(p);
  const pct = Math.round(s * 100);
  return (
    <div className="cut cut-card bsx-a">
      <div className="bsx-a-bar" style={{ "--s": s } as Css} role="img" aria-label={`${pct}% redeemable now, ${100 - pct}% pending`}>
        <i className="now" />
        <i className="pend" />
      </div>
      <div className="bsx-a-legend">
        <div className="now">
          <span className="label"><i />Redeemable now</span>
          <b className="tnum"><GemaMark size={18} />{fmtGemas(p.redeemable)}</b>
          <span className="tnum">{usd(p.redeemable)}{p.redeemableSources ? ` · ${sources(p.redeemableSources)}` : ""}</span>
        </div>
        <div className="pend">
          <span className="label"><i />Pending</span>
          <b className="tnum">{fmtGemas(p.pending)}</b>
          <span>As each Source&apos;s yield accrues</span>
        </div>
      </div>
    </div>
  );
}

/* B — statement rows */
function Ledger(p: SplitProps) {
  return (
    <div className="cut cut-card bsx-b">
      <div className={`bsx-b-row now${p.redeemable === 0 ? " empty" : ""}`}>
        <span className="cut bsx-b-icon"><CheckIcon /></span>
        <span className="bsx-b-text">
          <span className="bsx-b-title">Redeemable now</span>
          <span className="tnum">{usd(p.redeemable)}{p.redeemableSources ? ` · ${sources(p.redeemableSources)}` : ""}</span>
        </span>
        <b className="tnum"><GemaMark size={18} />{fmtGemas(p.redeemable)}</b>
      </div>
      <div className="bsx-b-row pend">
        <span className="cut bsx-b-icon"><ClockIcon /></span>
        <span className="bsx-b-text">
          <span className="bsx-b-title">Pending</span>
          <span>Redeemable as each Source&apos;s yield accrues</span>
        </span>
        <b className="tnum">{fmtGemas(p.pending)}</b>
      </div>
    </div>
  );
}

/* C — pending flows into redeemable */
function Flow(p: SplitProps) {
  return (
    <div className="bsx-c-wrap"><div className="bsx-c">
      <div className="cut cut-card bsx-c-pend">
        <span className="label"><ClockIcon />Pending</span>
        <b className="tnum">{fmtGemas(p.pending)}</b>
        <span>{p.pending ? "Waiting on yield" : "Nothing waiting"}</span>
      </div>
      <div className="bsx-c-arrow" aria-hidden="true">
        <span className="bsx-c-dots"><i /><i /><i /></span>
        <ArrowIcon />
      </div>
      <div className={`cut cut-card bsx-c-now${p.redeemable === 0 ? " empty" : ""}`}>
        <span className="label"><CheckIcon />Redeemable now</span>
        <b className="tnum"><GemaMark size={20} />{fmtGemas(p.redeemable)}</b>
        <span className="tnum">{usd(p.redeemable)}{p.redeemableSources ? ` · ${sources(p.redeemableSources)}` : ""}</span>
      </div>
    </div></div>
  );
}

/* D — redeemable leads, pending follows */
function Lead(p: SplitProps) {
  const s = share(p);
  return (
    <div className="cut cut-card bsx-d">
      <span className="label">Redeemable now</span>
      <div className="bsx-d-fig">
        <GemaMark size={30} />
        <b className={`tnum${p.redeemable === 0 ? " empty" : ""}`}>{fmtGemas(p.redeemable)}</b>
        <span className="tnum">{usd(p.redeemable)}{p.redeemableSources ? ` · ${sources(p.redeemableSources)}` : ""}</span>
      </div>
      <div className="bsx-d-pend">
        <ClockIcon />
        <span>
          <b className="tnum">{fmtGemas(p.pending)}</b> pending as yield accrues
        </span>
        <span className="bsx-d-meter" style={{ "--s": s } as Css} aria-hidden="true"><i /></span>
        <small className="tnum">{Math.round(s * 100)}% ready</small>
      </div>
    </div>
  );
}

/** Picks the variant from `?variant=` and mounts the floating switcher. `now` is the current markup. */
export function BalanceSplitSwitch({ now, ...p }: SplitProps & { now: React.ReactNode }) {
  const variant = usePrototypeVariant(BALANCE_SPLIT_VARIANTS.map((v) => v.key));
  return (
    <>
      {variant === "now" ? now : <BalanceSplitPrototype variant={variant} {...p} />}
      <PrototypeSwitcher variants={BALANCE_SPLIT_VARIANTS} />
    </>
  );
}
