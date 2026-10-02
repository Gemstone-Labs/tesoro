import { ArrowRight, Plus } from "lucide-react";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { OUTBOUND } from "@/lib/landing/config";

const CATALOGUE = [
  { src: art.blockPuzzleTile, name: "Block Puzzle", live: true },
  { src: art.holdemTile, name: "Heads-up Hold’em", live: true },
  { src: art.comingSoon["word-duel"], name: "Word Duel" },
  { src: art.comingSoon["bubble-burst"], name: "Bubble Burst" },
];

/** The Pot at settlement, drawn as proportions only (the fee levels aren't set). */
function PotSplit() {
  return (
    <div className="lp-pot" aria-label="A Pot at settlement: the winner's share, your Studio Fee, and Tesoro's Platform Fee.">
      <span className="lp-pot-bar" aria-hidden>
        <i className="win" />
        <i className="studio" />
        <i className="platform" />
      </span>
      <ul className="lp-pot-legend">
        <li>
          <i className="win" /> Winner
        </li>
        <li>
          <i className="studio" /> <b>Your Studio Fee</b>, you set it
        </li>
        <li>
          <i className="platform" /> Platform Fee
        </li>
      </ul>
      <p className="lp-pot-note mono">Proportions illustrative</p>
    </div>
  );
}

export function Studios() {
  return (
    <section id="studios" className="lp-section lp-studios" aria-labelledby="studios-title">
      <div className="lp-wrap">
        <header className="lp-studios-head">
          <h2 id="studios-title" className="lp-h2" data-reveal>
            Built for studios
          </h2>
          <p className="lp-lede lp-measure" data-reveal>
            Bring a skill game. Tesoro brings Players who already hold Gemas, and the settlement on chain.
          </p>
        </header>
        <div className="lp-bento">
          <article className="lp-tile lp-tile-list cut cut-frame" data-reveal>
            <h3 className="lp-h3">List your game for free.</h3>
            <ul className="lp-catalogue" aria-label="Games on Tesoro">
              {CATALOGUE.map((g) => (
                <li key={g.name} className={`cut cut-card${g.live ? "" : " soon"}`}>
                  <picture>
                    <img src={g.src} alt="" width={768} height={768} loading="lazy" />
                  </picture>
                  <span>{g.name}</span>
                </li>
              ))}
              <li className="lp-slot cut cut-card">
                <Plus aria-hidden />
                <span>Your game</span>
              </li>
            </ul>
          </article>
          <article className="lp-tile lp-tile-fee cut cut-frame" data-reveal>
            <h3 className="lp-h3">Set your own Studio Fee on every Pot.</h3>
            <p className="lp-body">It sits on top of Tesoro&rsquo;s Platform Fee, taken in Gemas at settlement.</p>
            <PotSplit />
          </article>
          <article className="lp-tile lp-tile-players cut cut-frame" data-reveal>
            <h3 className="lp-h3">Players arrive with Gemas already in hand.</h3>
            <p className="lp-body">No deposit flow to build: they pick an entry and play.</p>
            <div className="lp-arrive" aria-hidden>
              <span className="lp-pill cut cut-btn">
                <GemaMark size={18} /> Gemas
              </span>
              <ArrowRight />
              <span className="lp-pill cut cut-btn">Entry</span>
              <ArrowRight />
              <span className="lp-pill strong cut cut-btn">Your game</span>
            </div>
          </article>
        </div>
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
