"use client";

/**
 * PROTOTYPE ONLY (branch proto/advance-sheet-11-10-2026). Four takes on the Take an Advance sheet, switched by
 * `?variant=now|A|B|C|D`. Question: what should picking a Horizon and taking an Advance look like?
 * Throwaway: the winner gets rewritten into AdvanceSheet.tsx on main.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lock, Unlock } from "lucide-react";
import { Button, ChainChip, ChainGlyph, CheckIcon, CountUp, CrossChainProgress, GemaAmount, GemaMark, SimulatedYieldLabel, Slider } from "@/components/ui";
import { quoteAdvance } from "@/lib/advance";
import { fmtAsset, fmtGemas, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { MOCK_NOW } from "@/lib/mock";
import type { Position } from "@/lib/mock";
import "./advance-sheet.prototype.css";

export const ADVANCE_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Exchange" },
  { key: "B", name: "Horizon dial" },
  { key: "C", name: "Pick your Gemas" },
  { key: "D", name: "Yield timeline" },
] as const;
export type AdvanceVariant = (typeof ADVANCE_VARIANTS)[number]["key"];

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const monthsLabel = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;

export function AdvanceFormPrototype({ variant, position, onClose }: { variant: Exclude<AdvanceVariant, "now">; position: Position; onClose: () => void }) {
  const [months, setMonths] = useState(3);
  const [taken, setTaken] = useState(false);
  const quote = quoteAdvance(position, months, MOCK_NOW);
  const props = { position, months, setMonths, quote, onTake: () => setTaken(true) };

  if (taken) return <Taken position={position} gemas={quote.gemasIssued} unlock={quote.unlockEstimate} onClose={onClose} />;
  if (variant === "A") return <Exchange {...props} />;
  if (variant === "B") return <Dial {...props} />;
  if (variant === "C") return <Tiles {...props} />;
  return <Timeline {...props} />;
}

type FormProps = {
  position: Position;
  months: number;
  setMonths: (m: number) => void;
  quote: ReturnType<typeof quoteAdvance>;
  onTake: () => void;
};

function TakeButton({ gemas, onTake }: { gemas: number; onTake: () => void }) {
  return (
    <Button variant="money" size="lg" block onClick={onTake}>
      Take Advance · <GemaMark size={18} /> {fmtGemas(gemas)}
    </Button>
  );
}

/* ——— A · Exchange: the Position's yield goes in, Gemas come out ——— */
function Exchange({ position, months, setMonths, quote, onTake }: FormProps) {
  return (
    <div className="pa">
      <div className="pa-source cut cut-card">
        <ChainGlyph asset={GLYPH[position.asset]} size={30} />
        <div>
          <strong>{fmtAsset(position.principal, position.asset)} Position</strong>
          <span className="meta">{(position.apy * 100).toFixed(1)}% APY · stays locked, never played</span>
        </div>
        <Lock size={16} className="pa-lock" aria-hidden />
      </div>

      <div className="pa-swap">
        <div className="pa-in">
          <span className="label">Yield over {monthsLabel(months)}</span>
          <b>{fmtAsset(quote.projectedYield, position.asset)}</b>
        </div>
        <div className="pa-arrow" aria-hidden>
          <i />
          <i />
          <i />
          <ArrowRight size={18} />
        </div>
        <div className="pa-out cut cut-card">
          <span className="label">You get now</span>
          <span className="pa-fig">
            <GemaMark size={26} />
            <CountUp value={quote.gemasIssued} duration={400} />
          </span>
          <span className="pa-usd">{fmtUsd(gemasToUsd(quote.gemasIssued))}</span>
        </div>
      </div>

      <Slider label="Horizon" value={months} min={1} max={12} onChange={setMonths} display={monthsLabel(months)} format={(m) => `${m}`} />

      <div className="pa-track">
        <span><b>Now</b> Gemas in your balance</span>
        <span className="pa-track-line" aria-hidden />
        <span><b>{fmtWhen(quote.unlockEstimate)}</b> Debt 0, Position unlocks</span>
      </div>

      <SimulatedYieldLabel />
      <TakeButton gemas={quote.gemasIssued} onTake={onTake} />
    </div>
  );
}

/* ——— B · Horizon dial: twelve months around a ring, the Gemas in the middle ——— */
function arc(i: number, r: number) {
  const a0 = ((-90 + i * 30 + 2) * Math.PI) / 180;
  const a1 = ((-90 + (i + 1) * 30 - 2) * Math.PI) / 180;
  const p = (a: number) => `${(120 + r * Math.cos(a)).toFixed(2)} ${(120 + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`;
}

function Dial({ position, months, setMonths, quote, onTake }: FormProps) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef(false);
  const pick = (e: React.PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    const deg = ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
    setMonths(Math.min(12, Math.max(1, Math.ceil(deg / 30))));
  };
  return (
    <div className="pb">
      <div className="pb-head">
        <ChainChip chain={position.chain} />
        <span className="meta">{fmtAsset(position.principal, position.asset)} · {(position.apy * 100).toFixed(1)}% APY</span>
      </div>
      <div className="pb-dial">
        <svg
          ref={svg}
          viewBox="0 0 240 240"
          onPointerDown={(e) => { drag.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); pick(e); }}
          onPointerMove={(e) => drag.current && pick(e)}
          onPointerUp={() => { drag.current = false; }}
          aria-hidden
        >
          <defs>
            <linearGradient id="pb-lit" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--em-hi)" />
              <stop offset="1" stopColor="var(--em-deep)" />
            </linearGradient>
          </defs>
          {Array.from({ length: 12 }, (_, i) => (
            <path key={i} d={arc(i, 100)} className={i < months ? "lit" : ""} style={{ ["--i" as string]: i }} />
          ))}
          {[1, 3, 6, 9, 12].map((m) => {
            const a = ((-90 + m * 30 - 15) * Math.PI) / 180;
            return (
              <text key={m} x={120 + 72 * Math.cos(a)} y={120 + 72 * Math.sin(a) + 4} className={m <= months ? "on" : ""}>{m}</text>
            );
          })}
        </svg>
        <div className="pb-centre">
          <span className="pb-fig"><GemaMark size={24} /><CountUp value={quote.gemasIssued} duration={300} /></span>
          <span className="pb-sub">Gemas for {monthsLabel(months)}</span>
        </div>
        <input
          className="sr-only"
          type="range"
          min={1}
          max={12}
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          aria-label="Horizon in months"
        />
      </div>
      <div className="pb-facts">
        <div className="cut cut-card"><span className="label">Worth</span><b>{fmtUsd(gemasToUsd(quote.gemasIssued))}</b></div>
        <div className="cut cut-card"><span className="label">Yield used</span><b>{fmtAsset(quote.projectedYield, position.asset)}</b></div>
        <div className="cut cut-card"><span className="label">Unlocks</span><b>{fmtWhen(quote.unlockEstimate)}</b></div>
      </div>
      <details className="pb-more">
        <summary>What happens to my Position?</summary>
        <p className="note">
          It stays locked until its Debt reaches zero, paid by its own yield. Your Principal is never played. The
          Unlock Estimate moves with the provider&apos;s actual yield.
        </p>
      </details>
      <SimulatedYieldLabel align="center" />
      <TakeButton gemas={quote.gemasIssued} onTake={onTake} />
    </div>
  );
}

/* ——— C · Pick your Gemas: choose an amount, the Horizon follows ——— */
const PRESETS = [1, 3, 6, 12];

function Tiles({ position, months, setMonths, quote, onTake }: FormProps) {
  const [custom, setCustom] = useState(!PRESETS.includes(months));
  return (
    <div className="pc">
      <p className="pc-lede">
        <ChainGlyph asset={GLYPH[position.asset]} size={16} /> How many Gemas from your {fmtAsset(position.principal, position.asset)} Position?
      </p>
      <div className="pc-tiles" role="radiogroup" aria-label="Horizon">
        {PRESETS.map((m) => {
          const q = quoteAdvance(position, m, MOCK_NOW);
          const on = !custom && m === months;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              className={`pc-tile cut cut-card${on ? " on" : ""}`}
              onClick={() => { setCustom(false); setMonths(m); }}
            >
              <GemaAmount value={q.gemasIssued} size="lg" />
              <span className="pc-usd">{fmtUsd(gemasToUsd(q.gemasIssued))}</span>
              <span className="pc-h">{monthsLabel(m)}</span>
              <span className="pc-u">unlocks {fmtWhen(q.unlockEstimate)}</span>
            </button>
          );
        })}
      </div>
      {custom ? (
        <Slider label="Other Horizon" value={months} min={1} max={12} onChange={setMonths} display={monthsLabel(months)} format={(m) => `${m}`} />
      ) : (
        <button type="button" className="pc-other" onClick={() => setCustom(true)}>Another Horizon</button>
      )}
      <ul className="pc-terms">
        <li><Lock size={14} aria-hidden /> Your {position.asset} stays locked until the Debt is 0</li>
        <li><CheckIcon /> The Position&apos;s own yield pays the Debt, not you</li>
        <li><CheckIcon /> Your Principal is never played</li>
      </ul>
      <div className="pc-note"><SimulatedYieldLabel /></div>
      <TakeButton gemas={quote.gemasIssued} onTake={onTake} />
    </div>
  );
}

/* ——— D · Yield timeline: twelve months of yield, drag where the Advance stops ——— */
function Timeline({ position, months, setMonths, quote, onTake }: FormProps) {
  const W = 400;
  const H = 150;
  const L = 8;
  const R = W - 8;
  const T = 14;
  const B = H - 22;
  const x = (m: number) => L + ((R - L) * m) / 12;
  const y = (m: number) => B - ((B - T) * m) / 12;
  const f = months / 12;
  return (
    <div className="pd">
      <div className="pd-top">
        <div>
          <span className="label">Gemas now</span>
          <span className="pd-fig"><GemaMark size={24} /><CountUp value={quote.gemasIssued} duration={300} /></span>
          <span className="meta">{fmtUsd(gemasToUsd(quote.gemasIssued))} · {fmtAsset(quote.projectedYield, position.asset)} of yield</span>
        </div>
        <ChainChip chain={position.chain} />
      </div>

      <div className="pd-chart" style={{ ["--f" as string]: f }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <pattern id="pd-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-2)" strokeWidth="2" />
            </pattern>
            <linearGradient id="pd-em" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--em)" stopOpacity=".75" />
              <stop offset="1" stopColor="var(--em-deep)" stopOpacity=".25" />
            </linearGradient>
          </defs>
          <polygon points={`${x(months)},${B} ${x(months)},${y(months)} ${x(12)},${y(12)} ${x(12)},${B}`} fill="url(#pd-hatch)" />
          <polygon points={`${x(0)},${B} ${x(months)},${y(months)} ${x(months)},${B}`} fill="url(#pd-em)" />
          <line x1={x(0)} y1={B} x2={x(12)} y2={y(12)} stroke="var(--line-2)" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          <line x1={x(0)} y1={B} x2={x(months)} y2={y(months)} stroke="var(--em-hi)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          <line x1={L} y1={B} x2={R} y2={B} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
          {Array.from({ length: 13 }, (_, m) => (
            <line key={m} x1={x(m)} y1={B} x2={x(m)} y2={B + 4} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <div className="pd-handle" aria-hidden>
          <span className="pd-bubble">{monthsLabel(months)}</span>
        </div>
        <div className="pd-axis" aria-hidden><span>Now</span><span>6 mo</span><span>12 mo</span></div>
        <input type="range" min={1} max={12} value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Horizon in months" />
      </div>

      <div className="pd-legend" aria-hidden>
        <span className="em"><i />Yield that pays back these Gemas</span>
        <span className="after"><i />Yield that stays yours</span>
      </div>

      <div className="pd-steps">
        <div><GemaMark size={16} /><span><b>Now</b> Gemas land in your balance</span></div>
        <div><Lock size={15} aria-hidden /><span><b>Until {fmtWhen(quote.unlockEstimate)}</b> yield pays the Debt down</span></div>
        <div><Unlock size={15} aria-hidden /><span><b>Then</b> Position unlocks, yield is yours again</span></div>
      </div>
      <SimulatedYieldLabel />
      <TakeButton gemas={quote.gemasIssued} onTake={onTake} />
    </div>
  );
}

/* ——— shared success: the Gemas count in ——— */
function Taken({ position, gemas, unlock, onClose }: { position: Position; gemas: number; unlock: string; onClose: () => void }) {
  const crossChain = position.chain !== "SOL";
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(1);
  useEffect(() => {
    if (!crossChain || stage >= 3) return;
    const t = setTimeout(() => setStage((s) => (s + 1) as 0 | 1 | 2 | 3), 2500);
    return () => clearTimeout(t);
  }, [crossChain, stage]);
  const landed = !crossChain || stage >= 3;
  return (
    <div className="pt">
      <div className={`pt-note balance cut cut-frame${landed ? " landed" : ""}`}>
        <span className="balance-label">{landed ? "Gemas issued" : "Gemas on the way"}</span>
        <span className="balance-fig"><GemaMark size={40} />{landed ? <CountUp value={gemas} from={0} duration={1100} /> : fmtGemas(gemas)}</span>
        <span className="balance-foot">
          <span>From your {fmtAsset(position.principal, position.asset)} Position</span>
          <span>Unlocks {fmtWhen(unlock)}</span>
        </span>
      </div>
      {crossChain && <CrossChainProgress stage={stage} chain={position.chain} txHash="0x7be1…a09c" />}
      <Button block onClick={onClose}>{landed ? "Go play" : "Close, it keeps going"}</Button>
    </div>
  );
}
