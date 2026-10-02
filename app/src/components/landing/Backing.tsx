import { art } from "@/lib/art";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { OfferDemo } from "./OfferDemo";
import { Picture } from "./Picture";

export function Backing() {
  const her = landingArt("herBacker");
  return (
    <section id="backing" className="lp-section lp-backing" aria-labelledby="backing-title">
      <div className="lp-wrap lp-backing-grid">
        <div className="lp-backing-copy">
          <h2 id="backing-title" className="lp-h2" data-reveal>
            Back a Player
          </h2>
          <p className="lp-lede lp-measure" data-reveal>
            Fund a Player&rsquo;s entry into one Match. If they win, your entry comes back first, then you share the surplus at the split you
            offered. They never owe anything.
          </p>
          <a className="lp-link" href={appHref("/backing")} data-reveal>
            Browse Requests →
          </a>
        </div>
        <div className="lp-backing-stage" data-reveal>
          <OfferDemo />
          <div className="lp-backing-her" aria-hidden>
            {her ? (
              <Picture k="herBacker" sizes="(max-width: 1023px) 180px, 300px" />
            ) : (
              <picture>
                <img src={art.busts.herBacking.src} width={art.busts.herBacking.w} height={art.busts.herBacking.h} alt="" loading="lazy" />
              </picture>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
