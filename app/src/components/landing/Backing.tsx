import Image from "next/image";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { OfferDemo } from "./OfferDemo";
import { Picture } from "./Picture";

/** Two more Requests peeking from behind the Offer card, so it reads as one of many on the board. Illustrative. */
const PEEKS = [
  { avatar: art.avatars[4], name: "Quartz Axolotl", game: "Hold'em", entry: 2500 },
  { avatar: art.avatars[8], name: "Topaz Lion", game: "Block Puzzle", entry: 500 },
];

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
          <div className="lp-board">
            <span className="lp-board-k mono">Open Requests</span>
            {PEEKS.map((p) => (
              <div key={p.name} className="lp-peek cut cut-frame" aria-hidden>
                <Image src={p.avatar} alt="" width={16} height={16} />
                <b>{p.name}</b>
                <span>
                  · {p.game} · asks <GemaMark size={11} /> {fmtGemas(p.entry)}
                </span>
              </div>
            ))}
            <OfferDemo />
          </div>
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
