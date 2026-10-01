import { appHref } from "@/lib/landing/config";
import { Picture } from "./Picture";

export function Hero() {
  return (
    <section id="top" className="lp-hero" aria-labelledby="hero-title">
      <div className="lp-hero-art" aria-hidden>
        <Picture k="heroBack" mobile="heroMobile" sizes="(max-width: 767px) 100vw, (max-width: 1023px) 100vw, 100vw" className="layer back" priority />
        <Picture k="heroMid" sizes="100vw" className="layer mid" />
        <Picture k="heroFront" sizes="100vw" className="layer front" />
      </div>
      <div className="lp-wrap lp-hero-copy" data-hero-copy>
        <h1 id="hero-title" className="lp-h1">
          <span className="sweep">Play now with yield you haven&rsquo;t earned yet.</span>
        </h1>
        <p className="lp-lede">Skill games on Solana; your staking Principal is never played.</p>
        <div className="lp-ctas">
          <a className="btn money lg cut cut-btn" href={appHref()}>
            Launch app
          </a>
          <a className="btn neutral lg cut cut-btn" href="#how-it-works">
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}
