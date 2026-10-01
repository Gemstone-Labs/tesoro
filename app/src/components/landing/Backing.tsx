import { Check, Minus, X } from "lucide-react";
import { art } from "@/lib/art";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { Picture } from "./Picture";

export function Backing() {
  const her = landingArt("herBacker");
  return (
    <section id="backing" className="lp-section lp-backing" aria-labelledby="backing-title">
      <div className="lp-wrap lp-backing-grid">
        <div>
          <h2 id="backing-title" className="lp-h2" data-reveal>
            Back a Player
          </h2>
          <p className="lp-lede lp-measure" data-reveal>
            Fund a Player&rsquo;s entry into one Match. If they win, your entry comes back first, then you share the surplus at the split you
            offered. If they lose, you lose that entry; they never owe anything.
          </p>
          <ul className="lp-outcomes">
            <li data-reveal>
              <Check aria-hidden /> <span><b>Win:</b> your entry back first, then your share of the surplus</span>
            </li>
            <li data-reveal>
              <X aria-hidden /> <span><b>Loss:</b> you lose that entry</span>
            </li>
            <li data-reveal>
              <Minus aria-hidden /> <span><b>Draw or refund:</b> your entry comes back</span>
            </li>
          </ul>
          <a className="lp-link" href={appHref("/backing")} data-reveal>
            Browse Requests →
          </a>
        </div>
        <div className="lp-backing-her" aria-hidden data-slide>
          {her ? (
            <Picture k="herBacker" sizes="(max-width: 1023px) 200px, 32vw" />
          ) : (
            <picture>
              <img src={art.busts.herBacking.src} width={art.busts.herBacking.w} height={art.busts.herBacking.h} alt="" loading="lazy" />
            </picture>
          )}
        </div>
      </div>
    </section>
  );
}
