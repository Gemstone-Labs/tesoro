"use client";

/**
 * PROTOTYPE ONLY (branch proto/gemas-section-11-10-2026). The current Gemas section ("Play now, your yield pays
 * later") with add-ons layered on top, picked with `?variant=` on /welcome:
 *   now  the section as shipped
 *   A    Pins: leader lines run into the frame and end on a pin; a tag on the stone says what the active beat means
 *   B    Proof: each card carries a small picture of its claim ($0.01 price tag, Source ticket, Debt draining to 0)
 *   C    Now → Later rail: a timeline under the heading, its fill following the beats
 *   D    Fill the corners: a lede top right, Launch app + docs bottom right, plainer beat lines
 *   E    Motion: the active card leans in, a spark runs its leader line into the Gema, big step counter on the plinth
 *   F    A + B + D together
 * Example figures are illustrative (10 SOL Advance, 6-month Horizon → 5,250 Gemas), same as the How it works prototype.
 * The section element stays the same across variants: the scroll controller pins it and writes data-beat on it.
 */
import type { ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { GemaMark } from "@/components/ui/gema";
import { appHref, OUTBOUND } from "@/lib/landing/config";
import { GemStage } from "./gem/GemStage";
import "./gemas.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Pins on the Gema" },
  { key: "B", name: "Proof in each card" },
  { key: "C", name: "Now → Later rail" },
  { key: "D", name: "Fill the corners" },
  { key: "E", name: "Motion" },
  { key: "F", name: "A + B + D" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { pins?: boolean; proof?: boolean; rail?: boolean; corners?: boolean; motion?: boolean };
const FLAGS: Record<Key, Flags> = {
  now: {},
  A: { pins: true },
  B: { proof: true },
  C: { rail: true },
  D: { corners: true },
  E: { motion: true },
  F: { pins: true, proof: true, corners: true },
};

type Beat = { line: ReactNode; plain?: ReactNode; support: string; plainSupport?: string; proof: ReactNode };

const BEATS: Beat[] = [
  {
    line: (
      <>
        1 Gema = <span className="lp-money">$0.01</span> at issuance.
      </>
    ),
    plain: (
      <>
        1 Gema = <span className="lp-money">$0.01</span> when it’s made.
      </>
    ),
    support: "One play unit, shared by every chain.",
    proof: <PriceTag />,
  },
  {
    line: "Every Gema is a claim on real staking yield.",
    plain: "Every Gema is backed by real staking yield.",
    support: "Each Gema keeps its Source: the Advance it was issued from, and the asset it redeems for.",
    plainSupport: "Each Gema remembers where it came from, and what it turns back into.",
    proof: <SourceTicket />,
  },
  {
    line: "The Advance is repaid from yield.",
    plain: "Your yield repays the Advance.",
    support: "Your Position’s yield pays down its Debt. When Debt reaches zero, the Position unlocks.",
    proof: <DebtBar />,
  },
];

export function GemasPrototype() {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  const f = FLAGS[v];
  const cls = ["lp-section", "lp-gemas", f.pins && "pg-pins", f.proof && "pg-proof", f.rail && "pg-rail", f.corners && "pg-corners", f.motion && "pg-motion"]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <section id="gemas" className={cls} aria-labelledby="gemas-title" data-gemas data-beat="0">
        <div className="lp-wrap">
          <header className="lp-gemas-head">
            <p className="lp-eyebrow mono">
              <GemaMark size={14} /> Gemas
            </p>
            <h2 id="gemas-title" className="lp-h2" data-reveal>
              <em className="lp-hl">Play now</em>, your yield <em className="lp-hl">pays later</em>
            </h2>
            {f.rail && <Rail />}
          </header>
          <div className="lp-gemas-stage">
            <ol className="lp-beats">
              {BEATS.map((b, i) => (
                <li key={i} className="lp-beat cut cut-card" data-beat-i={i} data-reveal>
                  <span className="lp-beat-n mono">0{i + 1}</span>
                  <p className="lp-beat-line">{f.corners && b.plain ? b.plain : b.line}</p>
                  <p className="lp-body">{f.corners && b.plainSupport ? b.plainSupport : b.support}</p>
                  {f.proof && <div className="pg-proof-art">{b.proof}</div>}
                </li>
              ))}
            </ol>
            {f.corners && <Corners />}
            {(f.pins || f.motion) &&
              [0, 1, 2].map((i) => (
                <i key={i} className="pg-lead" data-lead={i} aria-hidden>
                  <span className="pg-spark" />
                </i>
              ))}
            <div className="lp-showcase">
              <span className="lp-showcase-rays" aria-hidden />
              <Vitrine />
              <span className="lp-beam" aria-hidden />
              <span className="lp-sparkles" aria-hidden>
                {Array.from({ length: 9 }, (_, i) => (
                  <i key={i} style={{ ["--i" as string]: i }} />
                ))}
              </span>
              <GemStage />
              {f.pins && <Hud />}
              {f.motion && <Counter />}
            </div>
          </div>
        </div>
      </section>
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/** Concentric stepped octagons, like an emerald cut seen from above: the frame the Gema stands in. */
function Vitrine() {
  const ring = (inset: number) => {
    const [w, h, c] = [400 - inset * 2, 500 - inset * 2, 70 - inset * 0.55];
    const [x, y] = [inset, inset];
    return `M${x + c} ${y}H${x + w - c}L${x + w} ${y + c}V${y + h - c}L${x + w - c} ${y + h}H${x + c}L${x} ${y + h - c}V${y + c}Z`;
  };
  return (
    <svg className="lp-vitrine" viewBox="0 0 400 500" aria-hidden>
      {[0, 22, 44].map((i) => (
        <path key={i} d={ring(i)} className={i === 0 ? "outer" : "inner"} />
      ))}
      <path d={ring(0)} className="sweep" pathLength={100} />
    </svg>
  );
}

/* ——— A: a tag on the stone for the active beat (the leader lines and their pins are .pg-lead in the stage) ——— */

function Hud() {
  return (
    <div className="pg-hud" aria-hidden>
      <span className="pg-tag mono" data-tag="0">
        <GemaMark size={13} /> 1 = $0.01
      </span>
      <span className="pg-tag mono" data-tag="1">
        Source · 10 SOL Advance
      </span>
      <span className="pg-tag mono" data-tag="2">
        Debt <b>5,250</b> → <b className="lp-money">0</b>
      </span>
    </div>
  );
}

/* ——— B: a small picture of each claim ——— */

function PriceTag() {
  return (
    <div className="pg-price">
      {[
        ["1", "$0.01"],
        ["100", "$1"],
        ["1,000", "$10"],
      ].map(([g, usd]) => (
        <span key={g}>
          <GemaMark size={13} /> <b>{g}</b> <i>=</i> <span className="lp-money">{usd}</span>
        </span>
      ))}
    </div>
  );
}

function SourceTicket() {
  return (
    <div className="pg-ticket mono">
      <span>
        <GemaMark size={14} /> <b>5,250</b>
      </span>
      <span>
        from <b>10 SOL · 6 months</b> → turns back into <b>SOL</b>
      </span>
    </div>
  );
}

function DebtBar() {
  return (
    <div className="pg-debt">
      <div className="pg-debt-row mono">
        <span>
          Debt <b>5,250</b>
        </span>
        <span className="pg-debt-end">
          <b className="lp-money">0</b> · Position unlocks
        </span>
      </div>
      <div className="pg-debt-track">
        <span className="pg-debt-fill" />
      </div>
    </div>
  );
}

/* ——— C: Now → Later ——— */

function Rail() {
  return (
    <div className="pg-railbar" aria-hidden>
      <span className="pg-rail-end mono">
        <b className="lp-money">Now</b> Play with Gemas
      </span>
      <span className="pg-rail-track">
        <span className="pg-rail-fill" />
        {[0, 1, 2].map((i) => (
          <i key={i} data-tick={i} className="mono">
            0{i + 1}
          </i>
        ))}
      </span>
      <span className="pg-rail-end mono">
        <b className="lp-money">Later</b> Yield repays, you unlock
      </span>
    </div>
  );
}

/* ——— D: the two empty cells ——— */

function Corners() {
  return (
    <>
      <p className="pg-lede lp-body">
        Lock SOL, ETH or HYPE. Take its future staking yield today, as Gemas, and play. <b>Your Principal is never played.</b>
      </p>
      <div className="pg-cta">
        <span className="lp-cta-glow">
          <a className="btn money md cut cut-btn lp-shine" href={appHref()}>
            Play now
          </a>
        </span>
        <a className="btn neutral md cut cut-btn" href={`${OUTBOUND.docs}`}>
          How Gemas work
        </a>
      </div>
    </>
  );
}

/* ——— E: step counter on the plinth ——— */

function Counter() {
  return (
    <span className="pg-counter mono" aria-hidden>
      <b data-c="0">01</b>
      <b data-c="1">02</b>
      <b data-c="2">03</b>
      <i>/03</i>
    </span>
  );
}
