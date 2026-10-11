"use client";

/**
 * PROTOTYPE ONLY (branch proto/back-a-player-11-10-2026). The current Back a Player section with add-ons
 * layered on top, picked with `?variant=` on /welcome:
 *   now  the section as shipped
 *   A    Who you back: the Offer card opens on the Player's Request (animal, Game, record, Asks for)
 *   B    Plain lines: each outcome also says what happens in one sentence with live numbers
 *   C    Three promises: the empty left column gets Entry back first / You set the split / Owes nothing,
 *        each lighting its outcome in the card on hover; Browse Requests becomes a button
 *   D    Hand-off: a Gema flies from her hand into the stake whenever the entry changes; the stake counts up
 *   E    Board behind: two more Requests fanned behind the card, "12 open Requests"
 *   F    A + B + C together
 * The Player, record and board count are illustrative.
 */
import { Check, Minus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";
import { landingArt } from "@/lib/landing/art";
import { appHref } from "@/lib/landing/config";
import { Picture } from "./Picture";
import "./backing.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Who you back" },
  { key: "B", name: "Plain lines" },
  { key: "C", name: "Three promises" },
  { key: "D", name: "Gema hand-off" },
  { key: "E", name: "Board behind" },
  { key: "F", name: "A + B + C" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { player?: boolean; lines?: boolean; promises?: boolean; handoff?: boolean; board?: boolean };
const FLAGS: Record<Key, Flags> = {
  now: {},
  A: { player: true },
  B: { lines: true },
  C: { promises: true },
  D: { handoff: true },
  E: { board: true },
  F: { player: true, lines: true, promises: true },
};

type Outcome = "win" | "lose" | "draw";
const ENTRIES = [500, 1000, 2500];
const fmt = (n: number) => n.toLocaleString("en-US");

export function BackingPrototype() {
  const key = usePrototypeVariant(VARIANTS.map((v) => v.key));
  const f = FLAGS[key];
  const [lit, setLit] = useState<Outcome | null>(null);
  const her = landingArt("herBacker");
  const herRef = useRef<HTMLDivElement>(null);
  return (
    <section id="backing" className="lp-section lp-backing" aria-labelledby="backing-title" data-proto={key}>
      <div className="lp-wrap lp-backing-grid">
        <div className="lp-backing-copy">
          <h2 id="backing-title" className="lp-h2" data-reveal>
            Back a Player
          </h2>
          <p className="lp-lede lp-measure" data-reveal>
            Fund a Player&rsquo;s entry into one Match. If they win, your entry comes back first, then you share the surplus at the split you
            offered. They never owe anything.
          </p>
          {f.promises && <Promises onLight={setLit} />}
          {f.promises ? (
            <a className="btn money lg cut cut-btn bp-browse" href={appHref("/backing")}>
              Browse Requests
            </a>
          ) : (
            <a className="lp-link" href={appHref("/backing")} data-reveal>
              Browse Requests →
            </a>
          )}
        </div>
        <div className="lp-backing-stage" data-reveal>
          <div className={`bp-card-slot${f.board ? " bp-boarded" : ""}`}>
            {f.board && <Board />}
            <OfferDemoProto flags={f} lit={lit} herRef={herRef} />
          </div>
          <div className="lp-backing-her" aria-hidden ref={herRef}>
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
      <PrototypeSwitcher variants={VARIANTS} />
    </section>
  );
}

/* C: three promises, each pointing at its outcome row. */
function Promises({ onLight }: { onLight: (o: Outcome | null) => void }) {
  const rows: { o: Outcome; t: string; s: string }[] = [
    { o: "win", t: "Your entry back first", s: "Before any split, on every win." },
    { o: "draw", t: "You set the split", s: "Your Offer names the Player's share." },
    { o: "lose", t: "They owe nothing", s: "A loss costs you the entry. That's all." },
  ];
  return (
    <ul className="bp-promises" data-reveal>
      {rows.map((r) => (
        <li key={r.o} onMouseEnter={() => onLight(r.o)} onMouseLeave={() => onLight(null)} onFocus={() => onLight(r.o)} onBlur={() => onLight(null)} tabIndex={0}>
          <Check aria-hidden />
          <span>
            <b>{r.t}</b>
            <small>{r.s}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* E: two more Requests fanned behind the Offer card. */
function Board() {
  const ghosts = [
    { a: art.avatars[4], n: "Garnet Owl", g: "Hold'em", e: 2500 },
    { a: art.avatars[8], n: "Topaz Lynx", g: "Block Puzzle", e: 500 },
  ];
  return (
    <>
      {ghosts.map((p, i) => (
        <div key={p.n} className={`bp-ghost cut cut-frame g${i}`} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
          <img src={p.a} alt="" width={16} height={16} />
          <b>{p.n}</b>
          <small>
            · {p.g} · asks <GemaMark size={11} /> {fmt(p.e)}
          </small>
        </div>
      ))}
      <span className="bp-board-count mono">12 open Requests</span>
    </>
  );
}

/* A: the Request this Offer answers. */
function PlayerStrip({ entry }: { entry: number }) {
  return (
    <div className="bp-player">
      {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
      <img className="bp-avatar cut cut-btn" src={art.avatars[2]} alt="" width={56} height={56} />
      <div className="bp-who">
        <b>Onyx Fox</b>
        <span className="bp-rec">
          Block Puzzle · Won <em>64%</em> · 18 W · 10 L
        </span>
      </div>
      <div className="bp-asks">
        <span>Asks for</span>
        <b>
          <GemaMark size={14} /> {fmt(entry)}
        </b>
      </div>
    </div>
  );
}

function Lanes({ you, them }: { you: ReactNode; them: ReactNode }) {
  return (
    <div className="lp-lanes">
      <span className="lp-lane-k mono">You</span>
      <span className="lp-lane">{you}</span>
      <span className="lp-lane-k mono">Player</span>
      <span className="lp-lane">{them}</span>
    </div>
  );
}

/** Count up to `to` whenever it changes (D). */
function useCountUp(to: number, on: boolean) {
  const [v, setV] = useState(to);
  const from = useRef(to);
  useEffect(() => {
    if (!on) {
      from.current = to;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prototype
      setV(to);
      return;
    }
    const a = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 650);
      setV(Math.round(a + (to - a) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, on]);
  return v;
}

function OfferDemoProto({ flags: f, lit, herRef }: { flags: Flags; lit: Outcome | null; herRef: React.RefObject<HTMLDivElement | null> }) {
  const [entry, setEntry] = useState(1000);
  const [share, setShare] = useState(40);
  const [hover, setHover] = useState<Outcome | null>(null);
  const id = useId();
  const yours = 100 - share;
  const stakeRef = useRef<HTMLSpanElement>(null);
  const shown = useCountUp(entry, !!f.handoff);
  const on = lit ?? hover;

  const pick = (e: number) => {
    setEntry(e);
    if (f.handoff) fly(herRef.current, stakeRef.current);
  };

  const row = (o: Outcome) => ({
    className: `lp-oc ${o}${on === o ? " bp-lit" : ""}${on && on !== o ? " bp-dim" : ""}`,
    onMouseEnter: () => setHover(o),
    onMouseLeave: () => setHover(null),
  });

  return (
    <div className={`lp-offer cut cut-frame${f.lines ? " bp-has-lines" : ""}`}>
      {f.player && <PlayerStrip entry={entry} />}
      <div className="lp-offer-top">
        <p className="lp-offer-title">{f.player ? "Your Offer" : "Make an Offer"}</p>
        <span className="lp-offer-stake" ref={stakeRef}>
          <GemaMark size={16} /> {fmt(shown)}
        </span>
      </div>
      <div className="lp-entries" role="radiogroup" aria-label="Entry">
        {ENTRIES.map((e) => (
          <button key={e} type="button" role="radio" aria-checked={e === entry} className={`lp-entry cut cut-chip${e === entry ? " on" : ""}`} onClick={() => pick(e)}>
            {fmt(e)}
          </button>
        ))}
      </div>
      <div className="lp-offer-field">
        <label className="label" htmlFor={`${id}-share`}>
          Player&rsquo;s share <b className="lp-offer-pct">{share}%</b>
        </label>
        <input id={`${id}-share`} type="range" min={10} max={90} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} className="lp-range" />
      </div>

      <div className="lp-outcomes-v">
        <div {...row("win")}>
          <span className="lp-oc-head">
            <Check aria-hidden /> Win
          </span>
          <Lanes
            you={
              <>
                <i className="seg entry" style={{ flex: 50 }}>
                  {fmt(entry)} back
                </i>
                <i className="seg you" style={{ flex: (50 * yours) / 100 }}>
                  +{yours}%
                </i>
              </>
            }
            them={
              <i className="seg them" style={{ flex: (50 * share) / 100, maxWidth: `${(50 * share) / 100}%` }}>
                +{share}%
              </i>
            }
          />
          {f.lines && (
            <p className="bp-line">
              You get your <b>{fmt(entry)}</b> back, then <b>{yours}%</b> of the surplus. They keep <b>{share}%</b>.
            </p>
          )}
        </div>
        <div {...row("lose")}>
          <span className="lp-oc-head">
            <X aria-hidden /> Loss
          </span>
          <Lanes
            you={
              <i className="seg lost" style={{ flex: 50, maxWidth: "50%" }}>
                −{fmt(entry)}
              </i>
            }
            them={<i className="seg zero">owes 0</i>}
          />
          {f.lines && (
            <p className="bp-line">
              You lose the <b>{fmt(entry)}</b>. They owe you nothing.
            </p>
          )}
        </div>
        <div {...row("draw")}>
          <span className="lp-oc-head">
            <Minus aria-hidden /> Draw
          </span>
          <Lanes
            you={
              <i className="seg entry" style={{ flex: 50, maxWidth: "50%" }}>
                {fmt(entry)} back
              </i>
            }
            them={<i className="seg zero">0</i>}
          />
          {f.lines && (
            <p className="bp-line">
              Your <b>{fmt(entry)}</b> comes back. Nobody gains.
            </p>
          )}
        </div>
      </div>
      <p className="lp-offer-note mono">+% = share of the surplus, after Fees</p>
    </div>
  );
}

/** D: a Gema leaves her hand (roughly the glowing stone in the art) and lands on the stake. */
function fly(from: HTMLElement | null, to: HTMLElement | null) {
  if (!from || !to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const sx = a.left + a.width * 0.42;
  const sy = a.top + a.height * 0.58;
  const ex = b.left + 10;
  const ey = b.top + b.height / 2;
  const gem = document.createElement("span");
  gem.className = "bp-fly";
  gem.style.left = `${sx}px`;
  gem.style.top = `${sy}px`;
  document.body.appendChild(gem);
  const dx = ex - sx;
  const dy = ey - sy;
  const anim = gem.animate(
    [
      { transform: "translate(-50%,-50%) scale(1.2)", opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 90}px)) scale(1)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0.9 },
    ],
    { duration: 650, easing: "cubic-bezier(.4,0,.2,1)" },
  );
  anim.onfinish = () => {
    gem.remove();
    to.animate([{ transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
  };
}
