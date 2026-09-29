"use client";

import { useEffect, useState } from "react";
import { Button, CheckIcon, ChainChip, CrossChainProgress, GemaAmount, Sheet, Slider, SimulatedYieldLabel } from "@/components/ui";
import { quoteAdvance } from "@/lib/advance";
import { fmtAsset, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { MOCK_NOW } from "@/lib/mock";
import type { Position } from "@/lib/mock";

export function AdvanceSheet({ position, onClose }: { position: Position | null; onClose: () => void }) {
  return (
    <Sheet open={position !== null} onClose={onClose} title="Take an Advance">
      {position && <AdvanceForm key={position.id} position={position} onClose={onClose} />}
    </Sheet>
  );
}

function AdvanceForm({ position, onClose }: { position: Position; onClose: () => void }) {
  const [months, setMonths] = useState(3);
  const [taken, setTaken] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(1);
  const quote = quoteAdvance(position, months, MOCK_NOW);
  const crossChain = position.chain !== "SOL";

  useEffect(() => {
    if (!taken || !crossChain || stage >= 3) return;
    const t = setTimeout(() => setStage((s) => (s + 1) as 0 | 1 | 2 | 3), 2500);
    return () => clearTimeout(t);
  }, [taken, crossChain, stage]);

  if (taken) {
    return (
      <div className="stack">
        <div className="hstack">
          <ChainChip chain={position.chain} />
          <strong>{fmtAsset(position.principal, position.asset)} Position</strong>
        </div>
        {crossChain ? (
          <CrossChainProgress stage={stage} chain={position.chain} txHash="0x7be1…a09c" />
        ) : (
          <div className="status ok" role="status">
            <CheckIcon /> <GemaAmount value={quote.gemasIssued} size="md" /> issued
          </div>
        )}
        <Button block onClick={onClose}>Done</Button>
      </div>
    );
  }

  return (
    <>
      <p className="meta">
        {fmtAsset(position.principal, position.asset)} Position · {(position.apy * 100).toFixed(1)}% APY. An Advance is
        100% of the projected yield over the Horizon.
      </p>
      <Slider
        label="Horizon"
        value={months}
        min={1}
        max={12}
        onChange={setMonths}
        display={`${months} ${months === 1 ? "month" : "months"}`}
        minLabel="1 month"
        maxLabel="12 months"
      />
      <dl className="kv">
        <dt>Gemas issued</dt>
        <dd><GemaAmount value={quote.gemasIssued} size="lg" /></dd>
        <dt>Worth at issuance</dt>
        <dd>{fmtUsd(gemasToUsd(quote.gemasIssued))}</dd>
        <dt>Projected yield</dt>
        <dd>{fmtAsset(quote.projectedYield, position.asset)}</dd>
        <dt>Unlock Estimate</dt>
        <dd>{fmtWhen(quote.unlockEstimate)}</dd>
      </dl>
      <SimulatedYieldLabel />
      <p className="note">
        The Position stays locked until its Debt reaches zero. Principal is never played with. The Unlock Estimate moves
        with the provider&apos;s actual yield.
      </p>
      <Button variant="money" block onClick={() => setTaken(true)}>
        Take Advance · {quote.gemasIssued.toLocaleString("en-US")} Gemas
      </Button>
    </>
  );
}
