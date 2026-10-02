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
    support: "Your Position’s yield pays down its Debt. When Debt reaches zero, the Position unlocks.",
  },
];

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

export function Gemas() {
  return (
    <section id="gemas" className="lp-section lp-gemas" aria-labelledby="gemas-title" data-gemas data-beat="0">
      <div className="lp-wrap">
        <header className="lp-gemas-head">
          <p className="lp-eyebrow mono">
            <GemaMark size={14} /> Gemas
          </p>
          <h2 id="gemas-title" className="lp-h2" data-reveal>
            <em className="lp-hl">Play now</em>, your yield <em className="lp-hl">pays later</em>
          </h2>
        </header>
        <div className="lp-gemas-stage">
          <ol className="lp-beats">
            {BEATS.map((b, i) => (
              <li key={i} className="lp-beat cut cut-card" data-beat-i={i} data-reveal>
                <span className="lp-beat-n mono">0{i + 1}</span>
                <p className="lp-beat-line">{b.line}</p>
                <p className="lp-body">{b.support}</p>
              </li>
            ))}
          </ol>
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
          </div>
        </div>
      </div>
    </section>
  );
}
