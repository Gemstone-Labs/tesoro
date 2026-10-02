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
          {/* Same box maths as the dark hero, so the effects stay on the art at any viewport. */}
          <span className="lp-lantern-box">
            <span className="lp-rays day" />
            <Motes count={22} seed={41} className="lp-shaft-motes day" />
            <Glints
              at={[[88.3, 18.5, 0.4], [52.6, 41, 2.1], [77.3, 59.5, 3.7], [49.4, 19.5, 5.0], [74.6, 30.5, 1.5], [57.5, 70, 4.4]]}
              phone={[[22.4, 60, 0.4], [16.2, 52, 2.6], [71.5, 77, 3.7], [65.1, 57.5, 1.5], [80.3, 65, 4.6]]}
            />
            <span className="lp-crystal-glow" style={{ ["--x" as string]: "88.3%", ["--y" as string]: "28.7%", ["--mx" as string]: "22.4%", ["--my" as string]: "64%" }} />
            <span className="lp-crystal-glow sm" style={{ ["--x" as string]: "52.4%", ["--y" as string]: "45.9%", ["--mx" as string]: "71.5%", ["--my" as string]: "79%" }} />
          </span>
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
          <Glints
            at={[[87.6, 21.5, 0], [86.6, 14.8, 2.6], [54.2, 47.5, 1.2], [57.2, 72.5, 4.1], [77.6, 63.8, 3.3], [72.4, 5.6, 5.2]]}
            phone={[[88.1, 56, 0], [51.8, 57, 2.2], [21.2, 61.5, 3.8], [28.6, 79.5, 1.3], [60.4, 58.8, 4.9]]}
          />
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
