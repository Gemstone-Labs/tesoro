"use client";

/**
 * PROTOTYPE ONLY (branch proto/landing-hero-11-10-2026). Four takes on the landing hero beside the current one,
 * picked with `?variant=now|A|B|C|D`:
 *   A Game first — the copy beside a live gameplay loop in a cut frame, the cave dimmed behind.
 *   B Deposit line — the copy over the cave with a working Advance quote: pick a chain, an amount, a Horizon.
 *   C Product shot — centred copy, the real Lobby rising out of the cave in a tilted frame.
 *   D Game banner — no cave: the Game's own key art is the hero, with a tile rail to switch Games.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { Picture } from "./Picture";
import "./hero.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Game first" },
  { key: "B", name: "Deposit line" },
  { key: "C", name: "Product shot" },
  { key: "D", name: "Game banner" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];

export function HeroPrototype(props: Record<Key, ReactNode>) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {props[v]}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

function Title({ className = "" }: { className?: string }) {
  return (
    <h1 id="hero-title" className={`lp-h1 ${className}`}>
      Play now with <em className="lp-hl">yield</em> you haven&rsquo;t earned yet.
    </h1>
  );
}

function Cave({ dim }: { dim?: boolean }) {
  return (
    <div className={`lp-hero-art${dim ? " ph-dim" : ""}`} aria-hidden>
      <Picture k="heroBack" mobile="heroMobile" sizes="100vw" className="layer back" priority />
      <Picture k="heroMid" sizes="100vw" className="layer mid" />
      <Picture k="heroFront" sizes="100vw" className="layer front" />
    </div>
  );
}

const GAMES = [
  { id: "block-puzzle", name: "Block Puzzle", line: "90 s · same pieces for both Players", hero: art.blockPuzzleHero, tile: art.blockPuzzleTile },
  { id: "holdem", name: "Heads-up Hold’em", line: "Real-time · nobody sees the deck", hero: art.holdemHero, tile: art.holdemTile },
] as const;

/** Moves to the next Game every `secs` until the visitor picks one. */
function useRotate(n: number, secs: number) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), secs * 1000);
    return () => clearInterval(t);
  }, [n, secs, picked]);
  return [i, (x: number) => (setI(x), setPicked(true))] as const;
}

/* A — Game first */
export function HeroA() {
  const [i, pick] = useRotate(GAMES.length, 9);
  const g = GAMES[i];
  return (
    <section id="top" className="lp-hero ph-a" aria-labelledby="hero-title">
      <Cave dim />
      <div className="lp-wrap ph-a-grid" data-hero-copy>
        <div className="ph-a-copy">
          <Title className="ph-a-h1" />
          <p className="lp-lede">Lock SOL, ETH or HYPE. Get Gemas today from the yield it will earn, and play skill games for more. Your Principal is never played.</p>
          <div className="lp-ctas">
            <a className="btn money lg cut cut-btn lp-shine" href={appHref()}>
              Play now
            </a>
            <a className="btn neutral lg cut cut-btn" href="#how-it-works">
              How it works
            </a>
          </div>
        </div>
        <div className="ph-a-stage">
          <div className="ph-a-tabs" role="tablist" aria-label="Games">
            {GAMES.map((x, j) => (
              <button key={x.id} type="button" role="tab" aria-selected={j === i} className={`ph-a-tab cut cut-chip${j === i ? " on" : ""}`} onClick={() => pick(j)}>
                {x.name}
              </button>
            ))}
          </div>
          <div className="ph-a-screen cut cut-frame" style={{ ["--art" as string]: `url(${g.hero})` }}>
            <video key={g.id} className="ph-a-loop" muted loop playsInline autoPlay poster={`/art/landing/loop-${g.id}.webp`}>
              <source src={`/art/landing/loop-${g.id}.webm`} type="video/webm" />
              <source src={`/art/landing/loop-${g.id}.mp4`} type="video/mp4" />
            </video>
            <div className="ph-a-strip">
              <span>
                <b>{g.name}</b>
                <small>{g.line}</small>
              </span>
              <span className="ph-a-entry mono">
                Entry <GemaMark size={14} /> 100
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* B — Deposit line */
const CHAINS = {
  SOL: { usd: 150, apy: 0.07, amounts: [1, 5, 25] },
  ETH: { usd: 3000, apy: 0.03, amounts: [0.1, 0.5, 2] },
  HYPE: { usd: 40, apy: 0.022, amounts: [10, 50, 250] },
} as const;
type Chain = keyof typeof CHAINS;

export function HeroB() {
  const [chain, setChain] = useState<Chain>("SOL");
  const [amount, setAmount] = useState<number>(5);
  const [months, setMonths] = useState(12);
  const id = useId();
  const c = CHAINS[chain];
  const gemas = Math.floor((amount * c.apy * months * c.usd) / 12 / 0.01);
  return (
    <section id="top" className="lp-hero ph-b" aria-labelledby="hero-title">
      <Cave />
      <div className="lp-wrap ph-b-copy" data-hero-copy>
        <Title className="ph-b-h1" />
        <div className="ph-b-card cut cut-frame">
          <div className="ph-b-row">
            <span className="label">Lock</span>
            <div className="ph-b-chips" role="radiogroup" aria-label="Chain">
              {(Object.keys(CHAINS) as Chain[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={k === chain}
                  className={`ph-chip cut cut-chip${k === chain ? " on" : ""}`}
                  onClick={() => (setChain(k), setAmount(CHAINS[k].amounts[1]))}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div className="ph-b-row">
            <span className="label">Amount</span>
            <div className="ph-b-chips" role="radiogroup" aria-label="Amount">
              {c.amounts.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={a === amount} className={`ph-chip cut cut-chip${a === amount ? " on" : ""}`} onClick={() => setAmount(a)}>
                  {a} {chain}
                </button>
              ))}
            </div>
          </div>
          <div className="ph-b-row">
            <label className="label" htmlFor={`${id}-h`}>
              Horizon <b>{months} {months === 1 ? "month" : "months"}</b>
            </label>
            <input id={`${id}-h`} type="range" min={1} max={12} value={months} onChange={(e) => setMonths(Number(e.target.value))} className="lp-range" />
          </div>
          <div className="ph-b-out">
            <span className="label">You get now</span>
            <span className="ph-b-gemas">
              <GemaMark size={30} glint /> {fmt(gemas)}
            </span>
          </div>
          <a className="btn money lg block cut cut-btn lp-shine" href={appHref("/wallet")}>
            Get <GemaMark size={18} /> {fmt(gemas)}
          </a>
          <p className="ph-b-small">
            Your {amount} {chain} stays yours and is never played: its yield repays the Advance, then you Unlock it. Example at {(c.apy * 100).toFixed(1)}% a year, {chain} at ${fmt(c.usd)}.
          </p>
        </div>
      </div>
    </section>
  );
}

/* C — Product shot */
export function HeroC() {
  return (
    <section id="top" className="lp-hero ph-c" aria-labelledby="hero-title">
      <Cave dim />
      <div className="lp-wrap ph-c-in" data-hero-copy>
        <Title className="ph-c-h1" />
        <p className="lp-lede">Skill games on Solana; your staking Principal is never played.</p>
        <div className="lp-ctas ph-c-ctas">
          <a className="btn money lg cut cut-btn lp-shine" href={appHref()}>
            Launch app
          </a>
          <a className="btn neutral lg cut cut-btn" href="#how-it-works">
            How it works
          </a>
        </div>
        <div className="ph-c-shot">
          <span className="ph-c-halo" aria-hidden />
          <div className="ph-c-frame cut cut-frame">
            {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
            <img src="/docs/shot-lobby.webp" width={1280} height={800} alt="The Tesoro Lobby: Block Puzzle and Hold'em ready to play" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* D — Game banner */
const COMING = [art.comingSoon["word-duel"], art.comingSoon["pocket-pool"]];

export function HeroD() {
  const [i, pick] = useRotate(GAMES.length, 7);
  const g = GAMES[i];
  return (
    <section id="top" className="lp-hero ph-d" aria-labelledby="hero-title">
      <div className="ph-d-art" aria-hidden>
        {GAMES.map((x, j) => (
          // eslint-disable-next-line @next/next/no-img-element -- prototype
          <img key={x.id} src={x.hero} alt="" className={j === i ? "on" : ""} />
        ))}
      </div>
      <div className="lp-wrap ph-d-in" data-hero-copy>
        <p className="ph-d-kicker mono">Now playing · {g.name}</p>
        <Title className="ph-d-h1" />
        <p className="ph-d-line">
          Lock SOL, ETH or HYPE <i>→</i> get Gemas now <i>→</i> play. Your Principal is never played.
        </p>
        <div className="lp-ctas">
          <a className="btn money lg cut cut-btn lp-shine" href={appHref(`/play/${g.id}`)}>
            Play {g.name.replace("Heads-up ", "")}
          </a>
          <a className="btn neutral lg cut cut-btn" href="#how-it-works">
            How it works
          </a>
        </div>
        <div className="ph-d-rail" role="tablist" aria-label="Games">
          {GAMES.map((x, j) => (
            <button key={x.id} type="button" role="tab" aria-selected={j === i} className={`ph-d-tile cut cut-card${j === i ? " on" : ""}`} onClick={() => pick(j)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
              <img src={x.tile} alt="" />
              <span>{x.name}</span>
            </button>
          ))}
          {COMING.map((src) => (
            <span key={src} className="ph-d-tile soon cut cut-card" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
              <img src={src} alt="" />
              <span>Soon</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
