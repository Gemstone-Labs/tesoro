import { Info, Lock } from "lucide-react";

export function Principal() {
  return (
    <section id="principal" className="lp-section lp-principal" aria-labelledby="principal-title">
      <div className="lp-wrap">
        <h2 id="principal-title" className="lp-h2" data-reveal>
          Your Principal is never played
        </h2>
        <p className="lp-lede lp-measure" data-reveal>
          Only its yield pays Debt. The Principal itself is never entered into a Match and never spent.
        </p>
        <figure className="lp-flow" data-reveal data-flow aria-label="A Position: the Principal stays locked; its yield flows to Debt until Debt reaches zero and the Position unlocks.">
          <div className="lp-flow-box cut cut-card">
            <Lock aria-hidden />
            <span>
              <b>Principal</b>
              <span className="lp-body">Locked, never played</span>
            </span>
          </div>
          <div className="lp-flow-stream" aria-hidden>
            <span className="label">Yield</span>
          </div>
          <div className="lp-flow-box cut cut-card">
            <span>
              <b>Debt</b>
              <span className="lp-flow-meter" aria-hidden>
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} style={{ ["--i" as string]: i }} />
                ))}
              </span>
              <span className="lp-body">Repaid by yield</span>
            </span>
          </div>
          <div className="lp-flow-arrow" aria-hidden />
          <div className="lp-flow-box lp-flow-end cut cut-card">
            <span>
              <b>Unlock</b>
              <span className="lp-body">When Debt reaches zero</span>
            </span>
          </div>
        </figure>
        <p className="lp-note" data-reveal>
          <Info aria-hidden />
          Your Position stays locked while you have Debt, and it still carries the staking provider&rsquo;s risk and the asset&rsquo;s market risk.
        </p>
      </div>
    </section>
  );
}
