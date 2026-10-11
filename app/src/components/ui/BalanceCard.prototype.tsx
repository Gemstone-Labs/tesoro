"use client";

/**
 * PROTOTYPE ONLY (branch proto/balance-card-11-10-2026). Four BalanceCard variants on the real
 * component, switched by `?variant=` (A step cut, B stone and figure, C vault readout, D banknote, now).
 * All use proportional figures: tabular figures widen the thousands comma ("10 , 060").
 */
import { useEffect, useState } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { fmtGemas, fmtUsd, gemasToUsd } from "@/lib/format";
import { CountUp } from "./CountUp";
import { FacetCrown } from "./FacetCrown";
import { GemaMark, SimulatedYieldLabel } from "./gema";
import "./balance-card.prototype.css";

const VARIANTS = [
  { key: "A", name: "Step cut" },
  { key: "B", name: "Stone and figure" },
  { key: "C", name: "Vault readout" },
  { key: "D", name: "Banknote" },
  { key: "now", name: "Current" },
] as const;

type Props = { total: number; title: string };

function Figure({ total }: { total: number }) {
  return (
    <>
      <CountUp value={total} from={0} />
      <span className="sr-only"> Gemas</span>
    </>
  );
}

/** A: the panel is cut as an emerald step cut (the Wallet's facet crown); figure centred on the table. */
function VariantA({ total, title }: Props) {
  return (
    <section className="cut cut-frame facet-panel bcA" aria-label={title}>
      <FacetCrown />
      <span className="label">{title}</span>
      <div className="bcA-fig">
        <GemaMark size={36} glint />
        <span><Figure total={total} /></span>
      </div>
      <div className="bcA-foot">
        <span>≈ {fmtUsd(gemasToUsd(total))} <i>at issuance</i></span>
        <SimulatedYieldLabel />
      </div>
    </section>
  );
}

/** B: the Gema itself is the hero, set in a lit well; the figure reads beside it. */
function VariantB({ total, title }: Props) {
  return (
    <section className="cut cut-card bcB" aria-label={title}>
      <div className="cut bcB-well" aria-hidden="true">
        <GemaMark size={68} glint />
      </div>
      <div className="bcB-text">
        <span className="label">{title}</span>
        <b className="bcB-fig"><Figure total={total} /></b>
        <span className="bcB-usd">≈ {fmtUsd(gemasToUsd(total))} at issuance</span>
      </div>
      <SimulatedYieldLabel className="bcB-sim" />
    </section>
  );
}

/** C: a recessed readout, one cut cell per digit; digits roll in. The label row carries the simulated tag. */
function VariantC({ total, title }: Props) {
  const chars = fmtGemas(total).split("");
  const [run, setRun] = useState(0);
  return (
    <section className="cut cut-card bcC" aria-label={title}>
      <div className="bcC-head">
        <span className="label">{title}</span>
        <span className="cut cut-chip bcC-tag">Simulated yield · 1 month = 10 min</span>
      </div>
      <div className="cut bcC-track" onClick={() => setRun((r) => r + 1)} title="Click to replay">
        <GemaMark size={28} glint />
        <span className="bcC-cells" key={run} aria-hidden="true">
          {chars.map((ch, i) =>
            ch === "," ? (
              <span key={i} className="bcC-sep">,</span>
            ) : (
              <span key={i} className="cut bcC-cell" style={{ "--i": i } as React.CSSProperties}>
                <span>{ch}</span>
              </span>
            ),
          )}
        </span>
        <span className="sr-only">{fmtGemas(total)} Gemas</span>
      </div>
      <span className="bcC-usd">≈ {fmtUsd(gemasToUsd(total))} at issuance</span>
    </section>
  );
}

/** D: the card is the money fill, a banknote: ink figure and ink Gema mark on emerald. */
function VariantD({ total, title }: Props) {
  return (
    <section className="cut cut-card bcD" aria-label={title}>
      <div className="bcD-top">
        <span className="bcD-label">{title}</span>
        <span className="bcD-usd">≈ {fmtUsd(gemasToUsd(total))}</span>
      </div>
      <div className="bcD-fig">
        <GemaMark size={38} glint />
        <span><Figure total={total} /></span>
      </div>
      <div className="bcD-foot">
        <span>Value at issuance</span>
        <span className="bcD-sim">Simulated yield · 1 month = 10 min</span>
      </div>
    </section>
  );
}

// several cards on one page (the Widths story): only the first draws the switcher, or each arrow key would step N times
let mountedCards = 0;
function useFirstCard() {
  const [first, setFirst] = useState(false);
  useEffect(() => {
    mountedCards += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prototype: claim the switcher once
    setFirst(mountedCards === 1);
    return () => {
      mountedCards -= 1;
    };
  }, []);
  return first;
}

export function BalanceCardPrototype({ total, title, current }: Props & { current: React.ReactNode }) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  const first = useFirstCard();
  return (
    <>
      {v === "A" && <VariantA total={total} title={title} />}
      {v === "B" && <VariantB total={total} title={title} />}
      {v === "C" && <VariantC total={total} title={title} />}
      {v === "D" && <VariantD total={total} title={title} />}
      {v === "now" && current}
      {first && <PrototypeSwitcher variants={VARIANTS} />}
    </>
  );
}
