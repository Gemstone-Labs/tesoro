"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Button, ChainGlyph, CountUp, CrossChainProgress, GemaMark, Sheet, Slider, SimulatedYieldLabel } from "@/components/ui";
import { quoteAdvance } from "@/lib/advance";
import { fmtAsset, fmtGemas, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { MOCK_NOW } from "@/lib/mock";
import type { Position } from "@/lib/mock";
import "./advance-sheet.css";

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;
const monthsLabel = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;

export function AdvanceSheet({ position, onClose }: { position: Position | null; onClose: () => void }) {
  return (
    <Sheet open={position !== null} onClose={onClose} title="Take an Advance" className="adv-sheet">
      {position && <AdvanceForm key={position.id} position={position} onClose={onClose} />}
    </Sheet>
  );
}

function AdvanceForm({ position, onClose }: { position: Position; onClose: () => void }) {
  const [months, setMonths] = useState(3);
  const [taken, setTaken] = useState(false);
  const quote = quoteAdvance(position, months, MOCK_NOW);

  if (taken) return <Taken position={position} gemas={quote.gemasIssued} unlock={quote.unlockEstimate} onClose={onClose} />;

  return (
    <div className="adv">
      <div className="adv-source cut cut-card">
        <ChainGlyph asset={GLYPH[position.asset]} size={30} />
        <div>
          <strong>{fmtAsset(position.principal, position.asset)} Position</strong>
          <span className="meta">{(position.apy * 100).toFixed(1)}% APY · stays locked, never played</span>
        </div>
        <Lock size={16} className="adv-lock" aria-hidden />
      </div>

      <div className="adv-swap">
        <div className="adv-in">
          <span className="label">Yield over {monthsLabel(months)}</span>
          <b>{fmtAsset(quote.projectedYield, position.asset)}</b>
        </div>
        <svg className="adv-flow" viewBox="0 0 44 16" aria-hidden>
          <path d="M4 3l5 5-5 5M17 3l5 5-5 5M30 3l5 5-5 5" />
        </svg>
        <div className="adv-out cut cut-card">
          <span className="label">You get now</span>
          <span className="adv-fig">
            <GemaMark size={26} />
            <CountUp value={quote.gemasIssued} duration={400} />
          </span>
          <span className="adv-usd">{fmtUsd(gemasToUsd(quote.gemasIssued))}</span>
        </div>
      </div>

      <Slider label="Horizon" value={months} min={1} max={12} onChange={setMonths} display={monthsLabel(months)} format={(m) => `${m}`} />

      <div className="adv-track">
        <span><b>Now</b> Gemas in your balance</span>
        <span className="adv-track-line" aria-hidden />
        <span><b>{fmtWhen(quote.unlockEstimate)}</b> Unlock Estimate, Debt 0</span>
      </div>

      <SimulatedYieldLabel />
      <Button variant="money" size="lg" block onClick={() => setTaken(true)}>
        Take Advance · <GemaMark size={18} /> {fmtGemas(quote.gemasIssued)}
      </Button>
    </div>
  );
}

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
    <div className="adv">
      <div className={`adv-note balance cut cut-frame${landed ? "" : " pending"}`}>
        <span className="balance-label">{landed ? "Gemas issued" : "Gemas on the way"}</span>
        <span className="balance-fig">
          <GemaMark size={40} />
          {landed ? <CountUp value={gemas} from={0} duration={1100} /> : fmtGemas(gemas)}
        </span>
        <span className="balance-foot">
          <span>From your {fmtAsset(position.principal, position.asset)} Position</span>
          <span>Unlock Estimate {fmtWhen(unlock)}</span>
        </span>
      </div>
      {crossChain && <CrossChainProgress stage={stage} chain={position.chain} txHash="0x7be1…a09c" />}
      <Button block onClick={onClose}>{landed ? "Done" : "Close, it keeps going"}</Button>
    </div>
  );
}
