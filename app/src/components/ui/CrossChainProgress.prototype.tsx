"use client";

/**
 * PROTOTYPE ONLY (branch proto/crosschain-progress-11-10-2026). Four takes on CrossChainProgress, switched by
 * `?variant=now|A|B|C|D` on every page that renders it. Throwaway: the winner gets rewritten into money.tsx.
 */
import { useEffect, useState, type ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import type { Chain } from "@/lib/mock/types";
import { GemaMark } from "./gema";
import { CheckIcon, ClockIcon, MinusIcon, XIcon } from "./icons";
import { ChainGlyph } from "./inputs";
import "./crosschain.prototype.css";

export const XC_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Route" },
  { key: "B", name: "Status line" },
  { key: "C", name: "Facet dial" },
  { key: "D", name: "Lit rail" },
] as const;
type VariantKey = (typeof XC_VARIANTS)[number]["key"];

export interface XcProps {
  stage: number;
  failed: boolean;
  chain?: Chain;
  txHash?: string;
  steps: { title: string; note: string }[];
  label?: string;
  finalState: string;
  doneText: string;
  pendingText: string;
  failedText: string;
}

type State = "done" | "available" | "active" | "waiting" | "failed";
type Side = { kind: "chain"; asset: 0 | 1 | 2; name: string } | { kind: "gemas"; name: string };

const NETS: Record<string, Side> = {
  ETH: { kind: "chain", asset: 1, name: "Ethereum" },
  Ethereum: { kind: "chain", asset: 1, name: "Ethereum" },
  HYPE: { kind: "chain", asset: 2, name: "HyperEVM" },
  HyperEVM: { kind: "chain", asset: 2, name: "HyperEVM" },
  Hoodi: { kind: "chain", asset: 1, name: "Ethereum" },
  SOL: { kind: "chain", asset: 0, name: "Solana" },
};
const GEMAS: Side = { kind: "gemas", name: "Your Account" };

/** Prototype heuristic: the component only knows `chain` or a label like "ETH → Gemas" / "Redeem → HyperEVM". */
function inferEnds(p: XcProps): { from: Side; to: Side } {
  if (p.chain) return { from: NETS[p.chain], to: GEMAS };
  const [a, b] = (p.label ?? "").split("→").map((s) => s.trim());
  if (b && NETS[a]) return { from: NETS[a], to: GEMAS };
  if (b && NETS[b]) return { from: GEMAS, to: NETS[b] };
  const net = p.steps[0]?.title.replace(/ confirmed$/, "");
  return { from: NETS[net] ?? NETS.ETH, to: GEMAS };
}

function model(p: XcProps) {
  const last = p.steps.length;
  const states: State[] = p.steps.map((_, i) => {
    if (i < p.stage) return i === last - 1 ? "available" : "done";
    if (i === p.stage) return p.failed ? "failed" : "active";
    return "waiting";
  });
  const allDone = p.stage >= last && !p.failed;
  const current = Math.min(p.stage, last - 1);
  const word = (s: State) => ({ done: "Done", available: p.finalState, active: "In progress", waiting: "Waiting", failed: "Failed" })[s];
  const note = allDone ? p.doneText : p.failed ? p.failedText : p.pendingText;
  const ends = inferEnds(p);
  const label = p.label ?? (p.chain ? `${p.chain} → Gemas` : "Cross-chain");
  return { last, states, allDone, current, word, note, ends, label };
}
type Model = ReturnType<typeof model>;

const ICON = { done: CheckIcon, available: CheckIcon, active: ClockIcon, waiting: MinusIcon, failed: XIcon };

function SideMark({ side, size = 22 }: { side: Side; size?: number }) {
  return side.kind === "gemas" ? <GemaMark size={size} /> : <ChainGlyph asset={side.asset} size={size} />;
}

/* ——— A · Route: origin and destination as tiles, stations on a track, a packet gliding along it ——— */
function Route({ p, m }: { p: XcProps; m: Model }) {
  const mid = m.states.slice(1, -1);
  const legs = mid.length + 1;
  // packet sits at the step being worked on: origin = 0, destination = 1
  const at = p.stage === 0 ? 0 : (Math.min(p.stage, m.last - 1) - 0.5) / (m.last - 1);
  const s = m.states[m.current];
  return (
    <div className={`xa ${m.allDone ? "is-done" : p.failed ? "is-failed" : "is-live"}`}>
      <div className="xa-head">
        <span className="xa-kicker">{m.label}</span>
        {p.txHash && <span className="mono meta">{p.txHash}</span>}
      </div>
      <div className="xa-route">
        <div className={`xa-end cut cut-card ${m.states[0]}`}>
          <SideMark side={m.ends.from} size={26} />
        </div>
        <div className="xa-track" style={{ "--legs": legs } as React.CSSProperties}>
          {Array.from({ length: legs }, (_, i) => {
            const to = m.states[i + 1];
            const cls = to === "done" || to === "available" ? "lit" : to === "active" ? "live" : to === "failed" ? "broken" : "";
            return <span key={i} className={`xa-leg ${cls}`} />;
          })}
          {mid.map((st, i) => (
            <span
              key={i}
              className={`xa-stop cut ${st}`}
              style={{ left: `${((i + 1) / legs) * 100}%` }}
              title={p.steps[i + 1].title}
            />
          ))}
          {!m.allDone && <span className={`xa-packet ${p.failed ? "failed" : ""}`} style={{ left: `${at * 100}%` }} />}
        </div>
        <div className={`xa-end cut cut-card ${m.states[m.last - 1]}`}>
          <SideMark side={m.ends.to} size={26} />
        </div>
      </div>
      <div className="xa-names">
        <span>{m.ends.from.name}</span>
        <span>{m.ends.to.name}</span>
      </div>
      <div className="xa-now" role="status">
        <span className={`xa-state ${m.allDone ? "available" : s}`}>
          {m.allDone ? p.finalState : `Step ${m.current + 1} of ${m.last} · ${m.word(s)}`}
        </span>
        <strong>{m.allDone ? p.steps[m.last - 1].title : p.steps[m.current].title}</strong>
        <span className="xa-note">{m.allDone ? p.doneText : p.failed ? p.failedText : p.steps[m.current].note}</span>
      </div>
      {!m.allDone && !p.failed && <p className="note">{p.pendingText}</p>}
    </div>
  );
}

/* ——— B · Status line: one big word, a segmented cut bar, the steps folded away ——— */
function StatusLine({ p, m }: { p: XcProps; m: Model }) {
  const head = m.allDone ? p.steps[m.last - 1].title : p.failed ? "Stopped" : p.stage === 0 ? "Starting" : "Crossing chains";
  return (
    <div className={`xb ${m.allDone ? "is-done" : p.failed ? "is-failed" : "is-live"}`}>
      <div className="xb-top">
        <span className="xb-route">
          <SideMark side={m.ends.from} size={16} />
          <span aria-hidden>→</span>
          <SideMark side={m.ends.to} size={16} />
          <span>{m.label}</span>
        </span>
        <span className="xb-count tnum">
          {Math.min(p.stage, m.last)}/{m.last}
        </span>
      </div>
      <div className="xb-word" role="status">
        <span className="xb-dot" aria-hidden />
        {head}
      </div>
      <div className="xb-bar" aria-hidden>
        {m.states.map((st, i) => (
          <span key={i} className={`xb-seg cut ${st}`} />
        ))}
      </div>
      <p className="xb-line">
        {m.allDone ? (
          p.doneText
        ) : (
          <>
            <b>{p.steps[m.current].title}.</b> {p.failed ? p.failedText : p.steps[m.current].note}
          </>
        )}
      </p>
      <details className="xb-more">
        <summary>All steps{p.txHash ? <span className="mono"> · {p.txHash}</span> : null}</summary>
        <ol>
          {p.steps.map(({ title }, i) => {
            const st = m.states[i];
            const Icon = ICON[st];
            return (
              <li key={title} className={st}>
                <Icon width={14} height={14} />
                <span>{title}</span>
                <span className="xb-w">{m.word(st)}</span>
              </li>
            );
          })}
        </ol>
        {!m.allDone && !p.failed && <p className="note">{p.pendingText}</p>}
      </details>
    </div>
  );
}

/* ——— C · Facet dial: an octagon whose facets light one per step, the destination's gem in the table ——— */
const OCT = "M50 3 L69.5 3 L97 30.5 L97 69.5 L69.5 97 L30.5 97 L3 69.5 L3 30.5 L30.5 3 Z";
function Dial({ p, m }: { p: XcProps; m: Model }) {
  const seg = 100 / m.last;
  const gap = m.last > 3 ? 2.2 : 3;
  return (
    <div className={`xc2 ${m.allDone ? "is-done" : p.failed ? "is-failed" : "is-live"}`}>
      <div className="xc2-dial">
        <svg viewBox="0 0 100 100" aria-hidden>
          <path d={OCT} className="xc2-table" />
          {m.states.map((st, i) => (
            <path
              key={i}
              d={OCT}
              pathLength={100}
              className={`xc2-facet ${st}`}
              strokeDasharray={`${seg - gap} ${100 - seg + gap}`}
              strokeDashoffset={-(i * seg + gap / 2)}
            />
          ))}
        </svg>
        <div className="xc2-core">
          {m.allDone ? (
            <SideMark side={m.ends.to} size={34} />
          ) : (
            <>
              <SideMark side={m.ends.from} size={18} />
              <span className="xc2-n tnum">
                {Math.min(p.stage + 1, m.last)}
                <small>/{m.last}</small>
              </span>
            </>
          )}
        </div>
      </div>
      <div className="xc2-side">
        <div className="spread">
          <span className="xc2-kicker">{m.label}</span>
          {p.txHash && <span className="mono meta">{p.txHash}</span>}
        </div>
        <ol className="xc2-list">
          {p.steps.map(({ title, note }, i) => {
            const st = m.states[i];
            const Icon = ICON[st];
            return (
              <li key={title} className={st} aria-current={st === "active" ? "step" : undefined}>
                <Icon width={13} height={13} />
                <span>
                  {title}
                  {(st === "active" || st === "failed") && <small>{note}</small>}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="note" role="status">{m.note}</p>
      </div>
    </div>
  );
}

/* ——— D · Lit rail: endpoints top and bottom, light fills the rail, the live step is a card ——— */
function Rail({ p, m }: { p: XcProps; m: Model }) {
  const fill = m.allDone ? 1 : Math.max(0, p.stage) / Math.max(1, m.last - 1);
  return (
    <div className={`xd ${m.allDone ? "is-done" : p.failed ? "is-failed" : "is-live"}`}>
      <div className="spread">
        <span className="xd-kicker">{m.label}</span>
        {p.txHash && <span className="mono meta">{p.txHash}</span>}
      </div>
      <div className="xd-body" style={{ "--fill": Math.min(1, fill) } as React.CSSProperties}>
        <span className="xd-rail" aria-hidden />
        <div className="xd-end">
          <span className="xd-mark cut cut-chip"><SideMark side={m.ends.from} size={16} /></span>
          <span>From {m.ends.from.name}</span>
        </div>
        <ol className="xd-steps">
          {p.steps.map(({ title, note }, i) => {
            const st = m.states[i];
            const Icon = ICON[st];
            const open = st === "active" || st === "failed" || (st === "available" && m.allDone);
            return (
              <li key={title} className={`${st} ${open ? "open" : ""}`} aria-current={st === "active" ? "step" : undefined}>
                <span className="xd-node cut cut-chip"><Icon /></span>
                {open ? (
                  <div className={`xd-card cut cut-card ${st}`}>
                    <span className="xd-w">{m.word(st)}</span>
                    <b>{title}</b>
                    <span>{st === "failed" ? p.failedText : note}</span>
                    {st === "active" && <span className="xd-scan" aria-hidden />}
                  </div>
                ) : (
                  <span className="xd-t">{title}</span>
                )}
              </li>
            );
          })}
        </ol>
        <div className={`xd-end ${m.allDone ? "lit" : ""}`}>
          <span className="xd-mark cut cut-chip"><SideMark side={m.ends.to} size={16} /></span>
          <span>To {m.ends.to.name}</span>
        </div>
      </div>
      {!m.allDone && <p className="note" role="status">{p.failed ? "Nothing was spent." : p.pendingText}</p>}
    </div>
  );
}

const VIEWS: Record<Exclude<VariantKey, "now">, (a: { p: XcProps; m: Model }) => ReactNode> = {
  A: Route,
  B: StatusLine,
  C: Dial,
  D: Rail,
};

// one switcher per page however many trackers render
let claimed = false;
function OneSwitcher() {
  const [own, setOwn] = useState(false);
  useEffect(() => {
    if (claimed) return;
    claimed = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prototype: first tracker on the page owns the bar
    setOwn(true);
    return () => {
      claimed = false;
    };
  }, []);
  return own ? <PrototypeSwitcher variants={XC_VARIANTS} /> : null;
}

export function CrossChainPrototype({ props, children }: { props: XcProps; children: ReactNode }) {
  const variant = usePrototypeVariant(XC_VARIANTS.map((v) => v.key));
  const View = variant === "now" ? null : VIEWS[variant];
  return (
    <>
      {View ? <View p={props} m={model(props)} /> : children}
      <OneSwitcher />
    </>
  );
}
