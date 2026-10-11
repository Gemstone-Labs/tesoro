"use client";

// PROTOTYPE ONLY (branch proto/rows-11-10-2026): four list-row designs for the `Row` primitive,
// switched by `?variant=` (pink bar or ←/→). "now" is the current row. Delete on pick.
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import type { GameId } from "@/lib/mock/types";
import { ArrowIcon, CheckIcon, MinusIcon, XIcon } from "./icons";
import { GemaMark } from "./gema";
import "./row.prototype.css";

export const ROW_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Plate: art cut, button" },
  { key: "B", name: "Ledger: one table" },
  { key: "C", name: "Result tab: reveal on hover" },
  { key: "D", name: "Banner: hero art row" },
] as const;
type Key = (typeof ROW_VARIANTS)[number]["key"];

export interface RowProtoProps {
  thumb?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  cta?: string;
  ctaTone?: "neutral" | "money";
  href?: string;
  onClick?: () => void;
  children?: ReactNode;
  /** prototype: the Game, for art */
  game?: GameId;
  /** prototype: the Gema change, signed */
  delta?: number;
  /** prototype: "2 min ago" */
  when?: string;
}

const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");
const HERO: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero };
const tone = (d?: number) => (d === undefined ? null : d > 0 ? "won" : d < 0 ? "lost" : "even");
const fig = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toLocaleString("en-US")}`;
const ToneIcon = ({ t }: { t: string }) => (t === "won" ? <CheckIcon /> : t === "lost" ? <XIcon /> : <MinusIcon />);

/** Wraps a run of rows; the Ledger variant joins them into one table. */
export function RowList({ children }: { children: ReactNode }) {
  const v = usePrototypeVariant(ROW_VARIANTS.map((x) => x.key));
  return <div className={cx("rp-list", `rp-list-${v}`)}>{children}</div>;
}

function Shell({ p, className, children }: { p: RowProtoProps; className: string; children: ReactNode }) {
  const live = !!(p.href || p.onClick);
  const cls = cx(className, live && "live", p.ctaTone === "money" && "money");
  if (p.href) return <Link href={p.href} className={cls}>{children}</Link>;
  if (p.onClick) return <button type="button" className={cls} onClick={p.onClick}>{children}</button>;
  return <div className={cls}>{children}</div>;
}

function Figure({ d, className }: { d: number; className: string }) {
  const t = tone(d)!;
  return (
    <span className={cx(className, t)}>
      {t === "won" && <GemaMark size={16} />}
      <b className="tnum">{fig(d)}</b>
    </span>
  );
}

export function RowProto(p: RowProtoProps) {
  const v = usePrototypeVariant<Key>(ROW_VARIANTS.map((x) => x.key));
  if (v === "A") return <Plate {...p} />;
  if (v === "B") return <Ledger {...p} />;
  if (v === "C") return <ResultTab {...p} />;
  if (v === "D") return <Banner {...p} />;
  return <Current {...p} />;
}

function Current({ thumb, title, meta, cta, ctaTone = "neutral", href, onClick, children }: RowProtoProps) {
  const inner = (
    <>
      {thumb}
      <span className="row-body">
        <span className="row-title">{title}</span>
        {meta && <span className="row-meta">{meta}</span>}
      </span>
      {children}
      {cta && (
        <span className={cx("row-cta", ctaTone === "money" && "money")}>
          {cta}
          <ArrowIcon width={12} height={12} />
        </span>
      )}
    </>
  );
  const cls = "cut cut-card row";
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

/* A — Plate: the game's art cut on a slant at the left, a real button at the right. */
function Plate(p: RowProtoProps) {
  return (
    <Shell p={p} className="cut cut-card rp-a">
      {(p.game || p.thumb) && (
        <span className="rp-a-art">{p.game ? <Image src={art.thumb[p.game]} alt="" fill sizes="96px" /> : p.thumb}</span>
      )}
      <span className="rp-a-body">
        <span className="rp-a-title">{p.title}</span>
        {(p.meta || p.when) && (
          <span className="rp-a-meta">
            {p.meta}
            {p.meta && p.when && " · "}
            {p.when}
          </span>
        )}
      </span>
      {p.children}
      {p.delta !== undefined && <Figure d={p.delta} className="rp-a-fig" />}
      {p.cta && (
        <span className={cx("cut cut-btn rp-a-go", p.ctaTone === "money" && "money")}>
          {p.cta}
          <ArrowIcon width={14} height={14} />
        </span>
      )}
    </Shell>
  );
}

/* B — Ledger: rows are lines in one table; a column for the figure and one for the time. */
function Ledger(p: RowProtoProps) {
  const t = tone(p.delta);
  return (
    <Shell p={p} className="rp-b">
      <span className={cx("cut cut-chip rp-b-ic", t)}>
        {p.game ? <Image src={art.thumb[p.game]} alt="" fill sizes="40px" /> : (p.thumb ?? <span className="rp-b-dot" />)}
      </span>
      <span className="rp-b-body">
        <span className="rp-b-title">{p.title}</span>
        {p.meta && <span className="rp-b-meta">{p.meta}</span>}
      </span>
      {p.children}
      <span className={cx("rp-b-fig tnum", t)}>{p.delta !== undefined ? fig(p.delta) : ""}</span>
      <span className="rp-b-when">{p.when ?? ""}</span>
      <span className={cx("rp-b-go", p.ctaTone === "money" && "money")} aria-label={p.cta}>
        {p.cta && (p.ctaTone === "money" ? <b>{p.cta}</b> : <ArrowIcon width={16} height={16} />)}
      </span>
    </Shell>
  );
}

/* C — Result tab: a facet tab says the outcome; the figure owns the right; the action slides in on hover. */
function ResultTab(p: RowProtoProps) {
  const t = tone(p.delta);
  return (
    <Shell p={p} className={cx("cut cut-card rp-c", t && `t-${t}`)}>
      {(t || p.game || p.thumb) && (
        <span className="rp-c-tab">
          {t ? <ToneIcon t={t} /> : p.game ? <Image src={art.thumb[p.game]} alt="" fill sizes="64px" /> : p.thumb}
        </span>
      )}
      <span className="rp-c-body">
        <span className="rp-c-title">{p.title}</span>
        {(p.meta || p.when) && (
          <span className="rp-c-meta">
            {p.meta}
            {p.meta && p.when && " · "}
            {p.when}
          </span>
        )}
      </span>
      {p.children}
      {p.delta !== undefined && (
        <span className={cx("rp-c-fig", t)}>
          <b className="tnum">{fig(p.delta)}</b>
          <small>Gemas</small>
        </span>
      )}
      {p.cta && (
        <span className="rp-c-reveal">
          <span className={cx("rp-c-go", p.ctaTone === "money" && "money")}>
            {p.cta}
            <ArrowIcon width={14} height={14} />
          </span>
        </span>
      )}
    </Shell>
  );
}

/* D — Banner: the hero art fills the row from the right; text on the dark left, figure on a glass chip. */
function Banner(p: RowProtoProps) {
  const t = tone(p.delta);
  return (
    <Shell p={p} className={cx("cut cut-card rp-d", p.game && "has-art")}>
      {p.game && (
        <span className="rp-d-art">
          <Image src={HERO[p.game]} alt="" fill sizes="(max-width: 700px) 100vw, 900px" />
        </span>
      )}
      {!p.game && p.thumb && <span className="rp-d-thumb">{p.thumb}</span>}
      <span className="rp-d-body">
        {p.when && <span className="rp-d-kick">{p.when}</span>}
        <span className="rp-d-title">{p.title}</span>
        {p.meta && <span className="rp-d-meta">{p.meta}</span>}
      </span>
      {p.children}
      <span className="rp-d-side">
        {p.delta !== undefined && (
          <span className={cx("cut cut-chip rp-d-fig", t)}>
            {t && <ToneIcon t={t} />}
            <b className="tnum">{fig(p.delta)}</b>
          </span>
        )}
        {p.cta && (
          <span className={cx("rp-d-go", p.ctaTone === "money" && "money")}>
            {p.cta}
            <ArrowIcon width={14} height={14} />
          </span>
        )}
      </span>
    </Shell>
  );
}
