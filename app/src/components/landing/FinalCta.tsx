import { art } from "@/lib/art";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { XFollow } from "@/components/brand";
import { Motes } from "./Fx";
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
          <Motes count={18} seed={23} className="lp-final-motes" />
          {/* Phones: the climbers are baked into the phone art, so its lanterns and shaft get their own effects. */}
          <span className="lp-final-fx">
            <Motes count={14} seed={57} className="lp-final-motes-m" />
            <span className="lp-duo-lantern m" style={{ left: "68.5%", top: "61%" }} />
            <span className="lp-duo-lantern m" style={{ left: "53.3%", top: "85.8%" }} />
          </span>
          <div className="lp-final-duo-fade">
            <div className={duo ? "lp-final-duo rope" : "lp-final-duo"} data-climb>
              {duo && (
                <>
                  <Picture k="finalRope" sizes="420px" className="lp-final-rope" />
                  <span className="lp-duo-lantern" style={{ left: "86%", top: "31.5%" }} />
                  <span className="lp-duo-lantern" style={{ left: "28.5%", top: "75.5%" }} />
                </>
              )}
              {duo ? (
                <Picture k="finalDuo" sizes="420px" />
              ) : (
                <picture>
                  <img src={art.busts.duoHero.src.replace("/bust/", "/")} alt="" loading="lazy" width={1200} height={600} />
                </picture>
              )}
            </div>
          </div>
        </div>
        <div className="lp-wrap lp-final-copy">
          <h2 id="final-title" className="lp-h1 lp-final-title" data-reveal>
            Your <em className="lp-hl">yield</em> is ready to play.
          </h2>
          <div className="lp-final-actions" data-reveal>
            <span className="lp-cta-glow">
              <a className="btn money lg cut cut-btn lp-shine" href={appHref()}>
                Launch app
              </a>
            </span>
            <XFollow place="cta" className="lp-final-x" />
          </div>
        </div>
      </div>
    </section>
  );
}
