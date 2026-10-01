import { OUTBOUND } from "@/lib/landing/config";

const FACTS = [
  "List your game for free.",
  "Set your own Studio Fee on every Pot, on top of Tesoro’s Platform Fee.",
  "Players arrive with Gemas already in hand; no deposit flow to build.",
];

export function Studios() {
  return (
    <section id="studios" className="lp-section lp-studios" aria-labelledby="studios-title">
      <div className="lp-wrap">
        <h2 id="studios-title" className="lp-h2" data-reveal>
          Built for studios
        </h2>
        <ul className="lp-cards">
          {FACTS.map((f) => (
            <li key={f} className="lp-card cut cut-card" data-reveal>
              {f}
            </li>
          ))}
        </ul>
        <div className="lp-studios-foot" data-reveal>
          <p className="lp-body lp-measure">
            The Platform Fee is Tesoro&rsquo;s only revenue; nothing is charged on Principal, Advances or redemption.
          </p>
          {OUTBOUND.x && (
            <a className="btn neutral cut cut-btn" href={OUTBOUND.x} rel="noopener">
              Talk to us →
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
