"use client";

/**
 * PROTOTYPE ONLY (branch proto/studios-11-10-2026). The current "Built for studios" bento with add-ons
 * layered on top, picked with `?variant=` on /welcome:
 *   now  the section as shipped
 *   A    Set your fee: a Studio Fee slider; the ring and legend show real Gemas on a 1,000-Gema Pot
 *   B    Live and Soon: status tags on the catalogue, "Free to list" on the Your game slot (links to docs)
 *   C    Three steps: Ship a program / We register it / Earn on every Pot, under the bento
 *   D    Studio call: a footer with how settlement works + Talk to us, and three fee facts
 *   E    Example Pots: a short feed of settled Pots and the Studio's cut, under the ring
 *   F    A + B + D together
 * Every add-on variant also stops the travelling Gema before it covers "Your game".
 */
import { ArrowRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { OUTBOUND } from "@/lib/landing/config";
import "./studios.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Set your fee" },
  { key: "B", name: "Live and Soon" },
  { key: "C", name: "Three steps" },
  { key: "D", name: "Studio call" },
  { key: "E", name: "Example Pots" },
  { key: "F", name: "A + B + D" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { slider?: boolean; tags?: boolean; steps?: boolean; call?: boolean; feed?: boolean };
const FLAGS: Record<Key, Flags> = {
  now: {},
  A: { slider: true },
  B: { tags: true },
  C: { steps: true },
  D: { call: true },
  E: { feed: true },
  F: { slider: true, tags: true, call: true },
};

const CATALOGUE = [
  { src: art.blockPuzzleTile, name: "Block Puzzle", live: true },
  { src: art.holdemTile, name: "Heads-up Hold’em", live: true },
  { src: art.comingSoon["word-duel"], name: "Word Duel" },
  { src: art.comingSoon["bubble-burst"], name: "Bubble Burst" },
];

// docs/fees: Platform 2%, Leaderboard 1%, Studio 3% in the launch Games
const PLATFORM = 2;
const POOL = 1;
const POT = 1000;

function PotRing({ studio, exact }: { studio?: number; exact?: boolean }) {
  const gap = 1.5;
  const parts = exact
    ? [
        { cls: "win", pct: 100 - studio! - PLATFORM - POOL },
        { cls: "studio", pct: studio! },
        { cls: "platform", pct: PLATFORM },
        { cls: "pool", pct: POOL },
      ]
    : [
        { cls: "win", pct: 77.5 },
        { cls: "studio", pct: 10.5 },
        { cls: "platform", pct: 8 },
        { cls: "pool", pct: 5 },
      ];
  let off = 0;
  const arcs = parts.map((p) => {
    const a = { cls: p.cls, len: Math.max(0.6, p.pct - gap), off };
    off += p.pct;
    return a;
  });
  const gemas = (pct: number) => fmtGemas(Math.floor((POT * pct) / 100));
  return (
    <div className="lp-pot">
      <div className="lp-pot-ring" aria-hidden>
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="48" className="track" pathLength={100} />
          {arcs.map((a) => (
            <circle key={a.cls} cx="60" cy="60" r="48" className={a.cls} pathLength={100} strokeDasharray={`${a.len} ${100 - a.len}`} strokeDashoffset={-a.off} />
          ))}
        </svg>
        <span className="lp-pot-center">
          <GemaMark size={30} />
          <b>{exact ? fmtGemas(POT) : "Pot"}</b>
          {exact && <small className="sp-pot-unit">Pot</small>}
        </span>
      </div>
      <ul className={`lp-pot-legend${exact ? " sp-legend-num" : ""}`}>
        <li>
          <i className="win" /> Winner {exact && <em>{gemas(100 - studio! - PLATFORM - POOL)}</em>}
        </li>
        <li>
          <i className="studio" /> <b>Your Studio Fee</b> {exact && <em className="em">{gemas(studio!)}</em>}
        </li>
        <li>
          <i className="platform" /> Platform Fee {exact && <em>{gemas(PLATFORM)}</em>}
        </li>
        <li>
          <i className="pool" /> Leaderboard prize pool {exact && <em>{gemas(POOL)}</em>}
        </li>
      </ul>
    </div>
  );
}

function FeeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="sp-slider">
      <label htmlFor="sp-fee">
        Drag to try a fee <b>{value}%</b>
      </label>
      <input id="sp-fee" type="range" min={1} max={10} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <p>
        You earn <b className="em">{fmtGemas(Math.floor((POT * value) / 100))} Gemas</b> per {fmtGemas(POT)}-Gema Pot.
      </p>
    </div>
  );
}

const FEED = [
  { game: "Block Puzzle", pot: 1000 },
  { game: "Heads-up Hold’em", pot: 5000 },
  { game: "Block Puzzle", pot: 2000 },
  { game: "Heads-up Hold’em", pot: 1000 },
  { game: "Block Puzzle", pot: 5000 },
];

function PotFeed() {
  const [head, setHead] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setHead((h) => (h + 1) % FEED.length), 2200);
    return () => clearInterval(t);
  }, []);
  const rows = [0, 1, 2].map((i) => FEED[(head + i) % FEED.length]);
  return (
    <div className="sp-feed">
      <span className="sp-feed-label">Example Pots, settled</span>
      <ul>
        {rows.map((r, i) => (
          <li key={`${head}-${i}`} className={i === 0 ? "new" : undefined}>
            <span>{r.game}</span>
            <span className="pot">Pot {fmtGemas(r.pot)}</span>
            <b className="em">+{fmtGemas((r.pot * 3) / 100)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StudiosPrototype() {
  const key = usePrototypeVariant(VARIANTS.map((v) => v.key));
  const f = FLAGS[key];
  const [fee, setFee] = useState(3);
  const fixed = key !== "now";

  return (
    <section id="studios" className={`lp-section lp-studios${fixed ? " sp-fixed" : ""}`} aria-labelledby="studios-title">
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
                  {f.tags && <span className={`sp-tag${g.live ? " live" : ""}`}>{g.live ? "Live" : "Soon"}</span>}
                  <span>{g.name}</span>
                </li>
              ))}
              {f.tags ? (
                <li className="lp-slot cut cut-card sp-slot-link">
                  <a href={`${OUTBOUND.docs}/developers`}>
                    <Plus aria-hidden />
                    <span>Your game</span>
                    <small>Free to list</small>
                  </a>
                </li>
              ) : (
                <li className="lp-slot cut cut-card">
                  <Plus aria-hidden />
                  <span>Your game</span>
                </li>
              )}
            </ul>
          </article>
          <article className="lp-tile lp-tile-fee cut cut-frame" data-reveal>
            <h3 className="lp-h3">Set your own Studio Fee on every Pot.</h3>
            {f.slider ? <PotRing studio={fee} exact /> : <PotRing />}
            {f.slider && <FeeSlider value={fee} onChange={setFee} />}
            {f.feed && <PotFeed />}
          </article>
          <article className="lp-tile lp-tile-players cut cut-frame" data-reveal>
            <h3 className="lp-h3">Players arrive with Gemas already in hand.</h3>
            <p className="lp-body">No deposit flow to build: they pick an entry and play.</p>
            <div className="lp-arrive" aria-hidden>
              <span className="lp-arrive-token">
                <GemaMark size={14} />
              </span>
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

        {f.steps && (
          <ol className="sp-steps" data-reveal>
            <li>
              <span className="n">1</span>
              <div>
                <b>Ship your game as a Solana program.</b>
                <p>No server to run. The program reports who won.</p>
              </div>
            </li>
            <li>
              <span className="n">2</span>
              <div>
                <b>We register it with your Studio Fee.</b>
                <p>It shows up in the Lobby next to Block Puzzle and Hold’em.</p>
              </div>
            </li>
            <li>
              <span className="n">3</span>
              <div>
                <b>Earn on every Pot.</b>
                <p>Each Match settles on chain and pays your fee in Gemas.</p>
              </div>
            </li>
          </ol>
        )}

        {f.call ? (
          <div className="lp-studios-foot sp-call" data-reveal>
            <ul className="sp-facts">
              <li>Fixed when a Match opens</li>
              <li>Paid in Gemas at settlement</li>
              <li>Readable on chain by anyone</li>
            </ul>
            <div className="sp-call-btns">
              <a className="btn neutral cut cut-btn" href={`${OUTBOUND.docs}/developers/settlement`}>
                How settlement works
              </a>
              <a className="btn money cut cut-btn" href={OUTBOUND.x ?? `${OUTBOUND.docs}/developers`} rel="noopener">
                {OUTBOUND.x ? "Talk to us →" : "Read the developer docs →"}
              </a>
            </div>
          </div>
        ) : (
          OUTBOUND.x && (
            <div className="lp-studios-foot" data-reveal>
              <a className="btn neutral cut cut-btn" href={OUTBOUND.x} rel="noopener">
                Talk to us →
              </a>
            </div>
          )
        )}
      </div>
      <PrototypeSwitcher variants={VARIANTS} />
    </section>
  );
}
