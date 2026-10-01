import { art } from "@/lib/art";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { Picture } from "./Picture";

export function FinalCta() {
  const back = landingArt("finalBack");
  const duo = landingArt("finalDuo");
  return (
    <section id="launch" className="lp-final" aria-labelledby="final-title">
      <div className="lp-final-frame">
        <div className="lp-final-art" aria-hidden>
          {back ? (
            <Picture k="finalBack" mobile="finalMobile" sizes="100vw" className="layer back" />
          ) : (
            <Picture k="heroBack" sizes="100vw" className="layer back stand-in" />
          )}
          <div className={duo ? "lp-final-duo rope" : "lp-final-duo"} data-climb>
            {duo ? (
              <Picture k="finalDuo" sizes="420px" />
            ) : (
              <picture>
                <img src={art.busts.duoHero.src.replace("/bust/", "/")} alt="" loading="lazy" width={1200} height={600} />
              </picture>
            )}
          </div>
        </div>
        <div className="lp-wrap lp-final-copy">
          <h2 id="final-title" className="lp-h1 lp-final-title" data-reveal>
            Your yield is ready to play.
          </h2>
          <a className="btn money lg cut cut-btn" href={appHref()} data-reveal>
            Launch app
          </a>
        </div>
      </div>
    </section>
  );
}
