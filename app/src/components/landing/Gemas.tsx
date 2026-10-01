import { GemaMark } from "@/components/ui/gema";
import { GemStage } from "./gem/GemStage";

const BEATS = [
  {
    line: (
      <>
        1 Gema = <span className="lp-money">$0.01</span> at issuance.
      </>
    ),
    support: "One play unit, shared by every chain.",
  },
  {
    line: "Every Gema is a claim on real staking yield.",
    support: "Each Gema keeps its Source: the Advance it was issued from, and the asset it redeems for.",
  },
  {
    line: "The Advance is repaid from yield.",
    support:
      "Your Position’s yield pays down its Debt. When Debt reaches zero, the Position unlocks; the Unlock Estimate moves with the provider’s actual yield.",
  },
];

export function Gemas() {
  return (
    <section id="gemas" className="lp-section lp-gemas" aria-labelledby="gemas-title" data-gemas data-beat="0">
      <div className="lp-wrap lp-gemas-grid">
        <div className="lp-gemas-copy">
          <p className="lp-eyebrow mono">
            <GemaMark size={14} /> Gemas
          </p>
          <h2 id="gemas-title" className="lp-h2" data-reveal>
            Play now, your yield pays later
          </h2>
          <ol className="lp-beats">
            {BEATS.map((b, i) => (
              <li key={i} className="lp-beat" data-beat-i={i} data-reveal>
                <p className="lp-beat-line">{b.line}</p>
                <p className="lp-body">{b.support}</p>
              </li>
            ))}
          </ol>
          <div className="lp-beat-dots" aria-hidden>
            {BEATS.map((_, i) => (
              <span key={i} data-dot={i} />
            ))}
          </div>
        </div>
        <GemStage />
      </div>
    </section>
  );
}
