import type { CSSProperties } from "react";
import { Plus } from "lucide-react";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { OUTBOUND } from "@/lib/landing/config";
import { ArriveFlow } from "./ArriveFlow";
import { BRAND } from "@/lib/brand";

const CATALOGUE = [
  { src: art.blockPuzzleTile, name: "Block Puzzle", live: true },
  { src: art.holdemTile, name: "Buckshot Hold’em", live: true },
  { src: art.tradingDuelTile, name: "Trading Duel", live: true },
  { src: art.vanguardTile, name: "Vanguard", live: true },
  { src: art.comingSoon["word-duel"], name: "Word Duel" },
];

/** The Pot at settlement as a ring: illustrative proportions only. */
function PotRing() {
  // arc lengths in a pathLength of 100: winner, Studio Fee, Platform Fee, Leaderboard Fee, with small gaps
  const arcs = [
    { cls: "win", len: 76, off: 0 },
    { cls: "studio", len: 9, off: 77.5 },
    { cls: "platform", len: 6.5, off: 88 },
    { cls: "pool", len: 3.5, off: 96 },
  ];
  return (
    <div className="lp-pot">
      <div className="lp-pot-ring" aria-hidden>
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="48" className="track" pathLength={100} />
          {arcs.map((a) => (
            <circle key={a.cls} cx="60" cy="60" r="48" className={a.cls} pathLength={100} strokeDasharray={`${a.len} ${100 - a.len}`} strokeDashoffset={-a.off} style={{ "--len": a.len } as CSSProperties} />
          ))}
        </svg>
        <span className="lp-pot-center">
          <GemaMark size={30} />
          <b>Pot</b>
        </span>
      </div>
      <ul className="lp-pot-legend">
        <li>
          <i className="win" /> Winner
        </li>
        <li>
          <i className="studio" /> <b>Your Studio Fee</b>
        </li>
        <li>
          <i className="platform" /> Platform Fee
        </li>
        <li>
          <i className="pool" /> Leaderboard prize pool
        </li>
      </ul>
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
            Bring a skill game. {BRAND.name} brings Players who already hold Gemas, and the settlement on chain.
          </p>
        </header>
        <div className="lp-bento">
          <article className="lp-tile lp-tile-list cut cut-frame" data-reveal>
            <h3 className="lp-h3">List your game for free.</h3>
            <ul className="lp-catalogue" aria-label={`Games on ${BRAND.name}`}>
              {CATALOGUE.map((g) => (
                <li key={g.name} className={`cut cut-card${g.live ? "" : " soon"}`}>
                  <picture>
                    <img src={g.src} alt="" width={768} height={768} loading="lazy" />
                  </picture>
                  <span className={`lp-status${g.live ? " live" : ""}`}>{g.live ? "Live" : "Soon"}</span>
                  <span>{g.name}</span>
                </li>
              ))}
              <li className="lp-slot cut cut-card">
                <a href={`${OUTBOUND.docs}/developers`}>
                  <Plus aria-hidden />
                  <span>Your game</span>
                  <small>Free to apply</small>
                </a>
              </li>
            </ul>
          </article>
          <article className="lp-tile lp-tile-fee cut cut-frame" data-reveal>
            <h3 className="lp-h3">Set your own Studio Fee on every Pot.</h3>
            <PotRing />
          </article>
          <article className="lp-tile lp-tile-players cut cut-frame" data-reveal>
            <h3 className="lp-h3">Players arrive with Gemas already in hand.</h3>
            <p className="lp-body">No deposit flow to build: they pick an entry and play.</p>
            <ArriveFlow />
          </article>
        </div>
        {OUTBOUND.x && (
          <div className="lp-studios-foot" data-reveal>
            <a className="btn neutral cut cut-btn" href={OUTBOUND.x} rel="noopener">
              Talk to us →
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
