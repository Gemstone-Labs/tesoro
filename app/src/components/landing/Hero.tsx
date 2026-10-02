import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { Glints, Motes } from "./Fx";
import { Picture } from "./Picture";

export function Hero() {
  const light = landingArt("heroLight");
  return (
    <section id="top" className={light ? "lp-hero has-light-art" : "lp-hero"} aria-labelledby="hero-title">
      {light && (
        <div className="lp-hero-art lp-hero-light" aria-hidden>
          <Picture k="heroLight" mobile="heroLightMobile" sizes="100vw" className="layer" />
        </div>
      )}
      <div className="lp-hero-art" aria-hidden>
        <Picture k="heroBack" mobile="heroMobile" sizes="(max-width: 767px) 100vw, (max-width: 1023px) 100vw, 100vw" className="layer back" priority />
        <Picture k="heroMid" sizes="100vw" className="layer mid" />
        <Picture k="heroFront" sizes="100vw" className="layer front" />
        {/* Mirrors the art's object-fit: cover so the glow stays on the lantern glass at any viewport. */}
        <span className="lp-lantern-box">
          <span className="lp-rays" />
          <Motes count={26} seed={7} className="lp-shaft-motes" />
          <Glints at={[[87.6, 21.5, 0], [86.6, 14.8, 2.6], [54.2, 47.5, 1.2], [57.2, 72.5, 4.1], [77.6, 63.8, 3.3], [72.4, 5.6, 5.2]]} />
          <span className="lp-lantern wide" />
          <span className="lp-lantern" />
        </span>
      </div>
      <div className="lp-wrap lp-hero-copy" data-hero-copy>
        <h1 id="hero-title" className="lp-h1">
          <span className="sweep">
            Play now with <em className="lp-hl">yield</em> you haven&rsquo;t earned yet.
          </span>
        </h1>
        <p className="lp-lede">Skill games on Solana; your staking Principal is never played.</p>
        <div className="lp-ctas">
          <span className="lp-cta-glow">
            <a className="btn money lg cut cut-btn lp-shine" href={appHref()}>
              Launch app
            </a>
          </span>
          <a className="btn neutral lg cut cut-btn" href="#how-it-works">
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}
