"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button, ChainGlyph, CountUp, CrossChainProgress, GemaMark, Sheet, Slider, SimulatedYieldLabel } from "@/components/ui";
import { DEFAULT_HORIZON_MONTHS, quoteAdvance } from "@/lib/advance";
import { fmtAsset, fmtGemas, fmtWhen } from "@/lib/format";
import { MOCK_NOW } from "@/lib/mock";
import type { Chain, Position } from "@/lib/mock";
import { GemasLabel, UnlockTrack, YieldToGemas, monthsLabel } from "./AdvanceQuote";

const GLYPH = { SOL: 0, ETH: 1, HYPE: 2 } as const;

export function AdvanceSheet({ position, onClose }: { position: Position | null; onClose: () => void }) {
  return (
    <Sheet open={position !== null} onClose={onClose} title="Take an Advance" className="adv-sheet">
      {position && <AdvanceForm key={position.id} position={position} onClose={onClose} />}
    </Sheet>
  );
}

/** The Take an Advance body: the Position (locked), yield → Gemas, the Horizon, Now → Unlock and the money button. */
export function AdvanceFormView({
  chain,
  title,
  apy,
  months,
  onMonths,
  yieldText,
  gemas,
  unlock,
  yieldFeeBps,
  maxMonths = 12,
  sliderLabel = "Length",
  alerts,
  buttonLabel,
  disabled = false,
  dimmed = false,
  onSubmit,
}: {
  chain: Chain;
  /** "40.000 SOL Position". */
  title: string;
  /** "7.0% APY". */
  apy: string;
  months: number;
  onMonths: (m: number) => void;
  yieldText: string;
  gemas: number;
  unlock: string;
  /** The Yield Fee a later cash-out of these Gemas pays (the launch rate while the Treasury is unread). */
  yieldFeeBps?: number;
  /** Extend adds to a Horizon already running: the slider stops at what is left of the 12 months. */
  maxMonths?: number;
  sliderLabel?: string;
  alerts?: ReactNode;
  buttonLabel: ReactNode;
  disabled?: boolean;
  /** The quote is not on offer (Extend is blocked): shown faded and out of reach. */
  dimmed?: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="adv">
      <div className="adv-source cut cut-card">
        <ChainGlyph asset={GLYPH[chain]} size={30} />
        <div>
          <strong>{title}</strong>
          <span className="meta">{apy} · stays locked, never played</span>
        </div>
        <Lock size={16} className="adv-lock" aria-hidden />
      </div>

      <div className={`adv-quote${dimmed ? " dimmed" : ""}`} inert={dimmed}>
        <YieldToGemas months={months} yieldText={yieldText} gemas={gemas} yieldFeeBps={yieldFeeBps} />

        <Slider label={sliderLabel} value={months} min={1} max={maxMonths} onChange={onMonths} display={monthsLabel(months)} format={(m) => `${m}`} />

        <UnlockTrack now="Gemas in your balance" unlock={unlock} end="Unlock Estimate, paid back" />
      </div>

      {alerts}
      <SimulatedYieldLabel />
      <Button variant="money" size="lg" block disabled={disabled} onClick={onSubmit}>
        {buttonLabel}
      </Button>
    </div>
  );
}

/** Taken: a banknote counts the Gemas in; greyed and not counted while they are still on their way. */
export function AdvanceTakenNote({ gemas, from, unlock, landed = true }: { gemas: number; from: string; unlock: string; landed?: boolean }) {
  return (
    <div className={`adv-note balance cut cut-frame${landed ? "" : " pending"}`}>
      <span className="balance-label">{landed ? "Gemas issued" : "Gemas on the way"}</span>
      <span className="balance-fig">
        <GemaMark size={40} />
        {landed ? <CountUp value={gemas} from={0} duration={1100} /> : fmtGemas(gemas)}
      </span>
      <span className="balance-foot">
        <span>From your {from}</span>
        <span>Unlock Estimate {unlock}</span>
      </span>
    </div>
  );
}

function AdvanceForm({ position, onClose }: { position: Position; onClose: () => void }) {
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [taken, setTaken] = useState(false);
  const quote = quoteAdvance(position, months, MOCK_NOW);

  if (taken) return <Taken position={position} gemas={quote.gemasIssued} unlock={quote.unlockEstimate} onClose={onClose} />;

  return (
    <AdvanceFormView
      chain={position.chain}
      title={`${fmtAsset(position.principal, position.asset)} Lock`}
      apy={`${(position.apy * 100).toFixed(1)}% APY`}
      months={months}
      onMonths={setMonths}
      yieldText={fmtAsset(quote.projectedYield, position.asset)}
      gemas={quote.gemasIssued}
      unlock={fmtWhen(quote.unlockEstimate)}
      buttonLabel={<GemasLabel action="Take Advance" gemas={quote.gemasIssued} />}
      onSubmit={() => setTaken(true)}
    />
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
      <AdvanceTakenNote gemas={gemas} from={`${fmtAsset(position.principal, position.asset)} Lock`} unlock={fmtWhen(unlock)} landed={landed} />
      {crossChain && <CrossChainProgress stage={stage} chain={position.chain} txHash="0x7be1…a09c" />}
      <Button block onClick={onClose}>{landed ? "Done" : "Close, it keeps going"}</Button>
    </div>
  );
}
