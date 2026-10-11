"use client";

/**
 * PROTOTYPE ONLY (branch proto/how-it-works-11-10-2026). Four takes on the landing "How it works" section beside the
 * current flow diagram, picked with `?variant=now|A|B|C|D` on /welcome:
 *   A Loop — a cycle around the locked Principal: Advance → Play → yield repays → unlock or another Advance.
 *   B Try it — a worked example you drive: amount, Horizon, then flip Win / Lose and see what happens to each number.
 *   C Product tour — four steps on the left, the real app screen for the active step on the right.
 *   D Timeline — one Position's life on a time axis: Principal flat, Debt burning down, Gemas spent in Matches.
 * Example figures are illustrative (7% a year, SOL at $150, 1 Gema = $0.01).
 */
import { useEffect, useState, type ReactNode } from "react";
import { GemaMark } from "@/components/ui/gema";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { landingArt, type LandingKey } from "@/lib/landing/art";
import { Picture } from "./Picture";
import "./how.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Loop" },
  { key: "B", name: "Try it" },
  { key: "C", name: "Product tour" },
  { key: "D", name: "Timeline" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];

export function HowItWorksPrototype(props: Record<Key, ReactNode>) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {props[v]}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");
const APY = 0.07;
const SOL_USD = 150;
const gemasFor = (sol: number, months: number) => Math.floor((sol * APY * months * SOL_USD) / 12 / 0.01);

function Oct({ k, className = "", children }: { k?: LandingKey | "back"; className?: string; children?: ReactNode }) {
  return (
    <div className={`hp-oct ${className}`} aria-hidden>
      <span className="lp-oct-frame" />
      {k === "back" ? (
        <picture>
          <img src="/art/landing/back-a-player.webp" alt="" width={360} height={360} loading="lazy" />
        </picture>
      ) : k && landingArt(k) ? (
        <Picture k={k} sizes="140px" />
      ) : null}
      {children}
    </div>
  );
}

function Head({ children, lede }: { children?: ReactNode; lede: ReactNode }) {
  return (
    <header className="hp-head">
      <h2 id="how-title" className="lp-h2">
        {children ?? "How it works"}
      </h2>
      <p className="lp-lede lp-measure">{lede}</p>
    </header>
  );
}

/* ——— A. Loop ——— */

const LOOP = [
  { k: "step2" as const, n: "1", title: "Take an Advance", sub: "1–12 months of yield, today, as Gemas" },
  { k: "step4" as const, n: "2", title: "Play or Back a Player", sub: "Spend Gemas on Matches. Win the loser’s Gemas" },
  { k: "step3" as const, n: "3", title: "Yield repays it", sub: "Your Position’s yield pays the Debt down to zero" },
  { k: "step5" as const, n: "4", title: "Unlock or go again", sub: "Take your Principal back, or another Advance" },
];

export function HowA() {
  // Stations sit on a circle (centre 50/50, radius 38% of the box), clockwise from the top.
  const at = (i: number) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 2;
    return { left: `${50 + 38 * Math.cos(a)}%`, top: `${50 + 38 * Math.sin(a)}%` };
  };
  return (
    <section id="how-it-works" className="lp-section lp-how hp-a" aria-labelledby="how-title">
      <div className="lp-wrap hp-a-grid">
        <div className="hp-a-copy">
          <Head lede="Lock SOL, ETH or HYPE once. Its yield comes to you today as Gemas, then quietly pays itself back while you play." />
          <ol className="hp-a-list">
            {LOOP.map((s) => (
              <li key={s.n}>
                <span className="hp-n mono">{s.n}</span>
                <div>
                  <b>{s.title}</b>
                  <span>{s.sub}</span>
                </div>
              </li>
            ))}
          </ol>
          <p className="hp-a-note">
            <b>Win or lose, the yield repays the Advance.</b> Your Principal comes back either way. Winning just adds the loser&rsquo;s Gemas.
          </p>
        </div>
        <figure className="hp-ring" aria-label="A loop: take an Advance, play, yield repays it, then unlock or take another Advance. Your Position sits in the middle, never played.">
          <svg viewBox="0 0 100 100" aria-hidden>
            <defs>
              <filter id="hp-ring-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.2" />
              </filter>
              <marker id="hp-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
                <path d="M2 1L8 5L2 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </marker>
            </defs>
            <circle cx="50" cy="50" r="38" className="tube-glow" filter="url(#hp-ring-glow)" />
            <circle cx="50" cy="50" r="38" className="tube-outer" />
            <circle cx="50" cy="50" r="38" className="tube-core" />
            <circle cx="50" cy="50" r="38" className="tube-hi" />
            {[45, 135, 225, 315].map((deg) => (
              <path
                key={deg}
                className="hp-ring-arrow"
                d={`M${50 + 38 * Math.cos(((deg - 4) * Math.PI) / 180)} ${50 + 38 * Math.sin(((deg - 4) * Math.PI) / 180)}L${50 + 38 * Math.cos(((deg + 1) * Math.PI) / 180)} ${50 + 38 * Math.sin(((deg + 1) * Math.PI) / 180)}`}
                markerEnd="url(#hp-arrow)"
              />
            ))}
            <g className="hp-ring-dots">
              {[0, 1, 2].map((i) => (
                <circle key={i} r="0.9">
                  <animateMotion dur="9s" begin={`-${i * 3}s`} repeatCount="indefinite" path="M50 12A38 38 0 1 1 49.99 12" />
                </circle>
              ))}
            </g>
          </svg>
          <div className="hp-ring-centre">
            <Oct k="step1" className="lg" />
            <b>Your Position</b>
            <span>Principal locked, never played</span>
          </div>
          {LOOP.map((s, i) => (
            <div key={s.n} className={`hp-station s${i}`} style={at(i)}>
              <Oct k={s.k} />
              <b>
                <span className="mono">{s.n}</span> {s.title}
              </b>
            </div>
          ))}
        </figure>
      </div>
    </section>
  );
}

/* ——— B. Try it ——— */

const AMOUNTS = [5, 10, 50];

export function HowB() {
  const [sol, setSol] = useState(10);
  const [months, setMonths] = useState(6);
  const [won, setWon] = useState(true);
  const gemas = gemasFor(sol, months);
  return (
    <section id="how-it-works" className="lp-section lp-how hp-b" aria-labelledby="how-title">
      <div className="lp-wrap">
        <Head lede="Pick an amount and a Horizon. See what you get today, and what happens after a win or a loss." />
        <div className="hp-b-row">
          <div className="hp-b-step cut cut-frame">
            <span className="hp-n mono">1</span>
            <p className="hp-b-label">You lock</p>
            <p className="hp-b-big">
              {sol} <small>SOL</small>
            </p>
            <div className="hp-chips">
              {AMOUNTS.map((a) => (
                <button key={a} type="button" className={`cut cut-chip${a === sol ? " on" : ""}`} onClick={() => setSol(a)}>
                  {a} SOL
                </button>
              ))}
            </div>
            <p className="hp-b-foot">Your Principal. Locked in a Position, never played.</p>
          </div>
          <span className="hp-b-arrow" aria-hidden>
            ›››
          </span>
          <div className="hp-b-step cut cut-frame hp-b-get">
            <span className="hp-n mono">2</span>
            <p className="hp-b-label">You get today</p>
            <p className="hp-b-big em">
              <GemaMark size={30} /> {fmt(gemas)}
            </p>
            <label className="hp-b-slider">
              <span>
                Horizon <b>{months} {months === 1 ? "month" : "months"}</b>
              </span>
              <input type="range" min={1} max={12} value={months} onChange={(e) => setMonths(Number(e.target.value))} />
            </label>
            <p className="hp-b-foot">
              {months} {months === 1 ? "month" : "months"} of projected yield, as Gemas (${fmt(Math.round(gemas / 100))}).
            </p>
          </div>
          <span className="hp-b-arrow" aria-hidden>
            ›››
          </span>
          <div className={`hp-b-step cut cut-frame hp-b-out ${won ? "win" : "lose"}`}>
            <span className="hp-n mono">3</span>
            <p className="hp-b-label">You play a Match</p>
            <div className="hp-seg" role="group" aria-label="Match result">
              <button type="button" className={won ? "on" : ""} onClick={() => setWon(true)}>
                Win
              </button>
              <button type="button" className={won ? "" : "on"} onClick={() => setWon(false)}>
                Lose
              </button>
            </div>
            {won ? (
              <>
                <p className="hp-b-big em">
                  + <GemaMark size={26} /> {fmt(gemas)}
                </p>
                <p className="hp-b-foot">The loser&rsquo;s Gemas are yours, paid out as their yield lands.</p>
              </>
            ) : (
              <>
                <p className="hp-b-big lose">
                  − <GemaMark size={26} /> {fmt(gemas)}
                </p>
                <p className="hp-b-foot">Your Gemas go to the winner. Nothing else is taken.</p>
              </>
            )}
          </div>
        </div>
        <div className="hp-b-after cut cut-card">
          <div>
            <span className="hp-b-label">Principal</span>
            <b>{sol} SOL</b>
            <span>back in full</span>
          </div>
          <div>
            <span className="hp-b-label">Debt</span>
            <b>
              <GemaMark size={16} /> {fmt(gemas)} → 0
            </b>
            <span>repaid by your yield</span>
          </div>
          <div>
            <span className="hp-b-label">Unlocks in</span>
            <b>~{months} {months === 1 ? "month" : "months"}</b>
            <span>{won ? "and you keep the winnings" : "same as if you had won"}</span>
          </div>
        </div>
        <p className="hp-b-small mono">Example: 7% a year, SOL at $150, 1 Gema = $0.01.</p>
      </div>
    </section>
  );
}

/* ——— C. Product tour ——— */

const TOUR = [
  { title: "Lock SOL, ETH or HYPE", body: "Open a Position. Your Principal stays locked and is never played.", src: "/art/landing/proto-hiw/open.webp", w: 532, h: 693 },
  { title: "Get your yield today", body: "Take an Advance: 1–12 months of projected yield, paid now as Gemas.", src: "/art/landing/proto-hiw/advance.webp", w: 532, h: 563 },
  { title: "Play, or back a Player", body: "Spend Gemas on skill Matches. Win and you take the loser’s Gemas.", src: "/art/landing/proto-hiw/won.webp", w: 790, h: 600 },
  { title: "Yield pays it back", body: "Your Position’s yield pays the Debt down. At zero, unlock or go again.", src: "/art/landing/proto-hiw/repay.webp", w: 540, h: 617 },
];

export function HowC() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = window.setTimeout(() => setI((x) => (x + 1) % TOUR.length), 5000);
    return () => window.clearTimeout(t);
  }, [i, paused]);
  return (
    <section id="how-it-works" className="lp-section lp-how hp-c" aria-labelledby="how-title">
      <div className="lp-wrap hp-c-grid">
        <div>
          <Head lede="Four screens, start to finish. This is the app you’ll use." />
          <ol className="hp-c-steps">
            {TOUR.map((s, j) => (
              <li key={s.title}>
                <button
                  type="button"
                  className={j === i ? "on" : ""}
                  aria-current={j === i ? "step" : undefined}
                  onClick={() => {
                    setI(j);
                    setPaused(true);
                  }}
                >
                  <span className="hp-n mono">{j + 1}</span>
                  <span>
                    <b>{s.title}</b>
                    <span>{s.body}</span>
                  </span>
                  {j === i && !paused && <i className="hp-c-timer" />}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="hp-c-stage cut cut-frame">
          {TOUR.map((s, j) => (
            <img key={s.src} src={s.src} width={s.w} height={s.h} alt={j === i ? `Tesoro app: ${s.title}` : ""} className={j === i ? "on" : ""} loading="lazy" />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ——— D. Timeline ——— */

const MATCHES = [
  { m: 0.6, label: "Play", delta: "−1,000" },
  { m: 1.4, label: "Win", delta: "+900", win: true },
  { m: 2.5, label: "Back a Player", delta: "−2,000" },
  { m: 3.6, label: "Backed win", delta: "+1,500", win: true },
  { m: 4.7, label: "Play", delta: "−1,000" },
];

export function HowD() {
  const months = 6;
  const gemas = gemasFor(10, months);
  // Chart space: x 0..600 = months 0..6, three lanes.
  const x = (m: number) => 40 + (m / months) * 560;
  return (
    <section id="how-it-works" className="lp-section lp-how hp-d" aria-labelledby="how-title">
      <div className="lp-wrap">
        <Head lede="One Position over six months. Your Principal never moves. Your Gemas arrive on day one. Your yield pays them back." />
        <figure className="hp-d-chart cut cut-frame" aria-label={`Timeline: lock 10 SOL, get ${fmt(gemas)} Gemas today, play Matches, the Debt falls to zero by month 6 and the Position unlocks.`}>
          <div className="hp-d-lanes" aria-hidden>
            <span>
              <b>Principal</b>10 SOL
            </span>
            <span>
              <b>Gemas</b>yours to play
            </span>
            <span>
              <b>Debt</b>repaid by yield
            </span>
          </div>
          <svg viewBox="0 0 620 300" aria-hidden>
            {Array.from({ length: months + 1 }, (_, m) => (
              <g key={m} className="hp-d-grid">
                <line x1={x(m)} x2={x(m)} y1={14} y2={270} />
                <text x={x(m)} y={292}>
                  {m === 0 ? "Today" : `Month ${m}`}
                </text>
              </g>
            ))}
            {/* Principal lane: one flat, locked bar. */}
            <rect x={x(0)} y={28} width={x(months) - x(0)} height={30} rx={4} className="hp-d-principal" />
            <text x={x(0) + 12} y={48} className="hp-d-in">
              10 SOL locked · never played
            </text>
            <text x={x(months) - 12} y={48} className="hp-d-in end">
              back to you ↗
            </text>
            {/* Gemas lane: a drop on day one, then Matches. */}
            <line x1={x(0)} x2={x(months)} y1={128} y2={128} className="hp-d-axis" />
            <g className="hp-d-drop">
              <circle cx={x(0)} cy={128} r={13} />
              <text x={x(0) + 22} y={110}>
                +{fmt(gemas)} Gemas
              </text>
            </g>
            {MATCHES.map((e) => (
              <g key={e.m} className={`hp-d-match${e.win ? " win" : ""}`}>
                <rect x={x(e.m) - 6} y={122} width={12} height={12} transform={`rotate(45 ${x(e.m)} 128)`} />
                <text x={x(e.m)} y={154}>
                  {e.label}
                </text>
                <text x={x(e.m)} y={168} className="d">
                  {e.delta}
                </text>
              </g>
            ))}
            {/* Debt lane: burns down linearly to zero. */}
            <path d={`M${x(0)} 196L${x(months)} 258L${x(0)} 258Z`} className="hp-d-debt" />
            <path d={`M${x(0)} 196L${x(months)} 258`} className="hp-d-debt-line" />
            <text x={x(0) + 10} y={214} className="hp-d-in">
              {fmt(gemas)}
            </text>
            <g className="hp-d-unlock">
              <circle cx={x(months)} cy={258} r={7} />
              <text x={x(months) - 12} y={222}>
                Debt 0 · unlock or go again
              </text>
            </g>
          </svg>
        </figure>
        <div className="hp-d-legend">
          <p>
            <b className="em">Win</b> The loser&rsquo;s Gemas come to you as their yield lands.
          </p>
          <p>
            <b className="lose">Lose</b> Your Gemas go to the winner. The Debt line above does not change.
          </p>
        </div>
        <p className="hp-b-small mono">Example: 10 SOL, 6-month Horizon, 7% a year, SOL at $150.</p>
      </div>
    </section>
  );
}
