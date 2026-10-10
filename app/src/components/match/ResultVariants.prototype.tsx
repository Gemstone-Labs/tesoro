"use client";

/**
 * PROTOTYPE ONLY: three Match result screens with motion, switchable with `?variant=A|B|C|now` on
 * /design/result (`?case=won|lost|draw|refunded|backed-player|backer-won|holdem-won|holdem-lost`).
 * Question: what should Won / Lost / Draw feel like? A = today's card, every piece animated in
 * order; B = face-off seats (the Queue page's versus screen, finished) with a score race and the Pot
 * flying to the winner; C = full-bleed game art poster, giant word, gem rain, stat strip.
 * None of these show the MomentOverlay: the screen itself is the moment.
 */
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PlayerAvatar } from "@/components/account/Player";
import { Button, CheckIcon, CountUp, GemaMark, MinusIcon, SimulatedYieldLabel, XIcon } from "@/components/ui";
import { art, avatarFor } from "@/lib/art";
import { pointsForWin } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { MatchResultProps } from "./MatchResult";
import { RULES } from "./MatchResult";
import "./enter.css";
import "./result-proto.css";

export const RESULT_VARIANTS = [
  { key: "A", name: "Card, choreographed" },
  { key: "B", name: "Face-off" },
  { key: "C", name: "Poster" },
  { key: "now", name: "Current" },
] as const;
export type ResultVariantKey = (typeof RESULT_VARIANTS)[number]["key"];

type P = MatchResultProps & { players?: [string, string] };
type Css = CSSProperties & Record<`--${string}`, string | number>;

function derive(p: P) {
  const won = p.outcome === "won";
  const lost = p.outcome === "lost";
  const neutral = !won && !lost;
  const status = won ? "Won" : lost ? "Lost" : p.outcome === "draw" ? "Draw" : "Refunded";
  const Icon = won ? CheckIcon : lost ? XIcon : MinusIcon;
  const sign = p.delta > 0 ? "+" : p.delta < 0 ? "−" : "";
  const amount = neutral ? fmtGemas(p.entry) : `${sign}${fmtGemas(Math.abs(p.delta))}`;
  const pot = p.outcome === "refunded" ? p.entry : p.entry * 2;
  const fee = neutral ? 0 : p.fee;
  const nums = p.scores?.map(Number) ?? null;
  const numeric = !!nums && nums.every((n) => Number.isFinite(n));
  const points = won && p.role === "player" ? pointsForWin(p.entry) : 0;
  const amountLabel = p.backed ? (p.role === "backer" ? "Your return" : "Your share") : null;
  const youLabel = p.role === "backer" ? "Your Player" : "You";
  return { won, lost, neutral, status, Icon, amount, pot, fee, nums: numeric ? (nums as number[]) : null, points, amountLabel, youLabel };
}

/** A figure whose digits roll into place like an odometer; separators and signs stay put. */
function Odo({ text, delay = 0, className }: { text: string; delay?: number; className?: string }) {
  const chars = [...text];
  const digits = chars.filter((c) => /\d/.test(c)).length;
  let i = 0;
  return (
    <span className={`rp-odo${className ? ` ${className}` : ""}`} aria-label={text} role="img">
      {chars.map((c, k) => {
        if (!/\d/.test(c)) return <span key={k} className={`rp-odo-s${c === "," ? " sep" : ""}`} aria-hidden="true">{c}</span>;
        const d = Number(c);
        const order = i++;
        const rows = [...Array(20).keys()].map((n) => n % 10).concat([...Array(d + 1).keys()]);
        const style: Css = { "--to": 20 + d, "--dur": `${1100 + (digits - order) * 180}ms`, "--d": `${delay}ms` };
        return (
          <span key={k} className="rp-odo-col" aria-hidden="true">
            <span className="rp-odo-ghost">{c}</span>
            <span className="rp-odo-strip" style={style}>
              {rows.map((n, r) => <span key={r}>{n}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Emerald octagon shards: a one-shot burst from the centre, or a short rain from the top. */
function Shards({ n = 22, kind = "burst", delay = 0 }: { n?: number; kind?: "burst" | "rain"; delay?: number }) {
  return (
    <span className={`rp-shards ${kind}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + (i % 3) * 0.2;
        const r = 140 + ((i * 53) % 160);
        const style: Css =
          kind === "burst"
            ? { "--x": `${(Math.cos(a) * r).toFixed(1)}px`, "--y": `${(Math.sin(a) * r * 0.7).toFixed(1)}px`, "--r": `${(i * 67) % 360}deg`, "--s": `${8 + ((i * 7) % 14)}px`, "--d": `${delay + (i % 5) * 40}ms` }
            : { "--x": `${(i * 37) % 100}%`, "--r": `${(i * 67) % 360}deg`, "--s": `${10 + ((i * 7) % 18)}px`, "--d": `${delay + ((i * 211) % 2400)}ms`, "--t": `${2200 + ((i * 97) % 1600)}ms` };
        return <i key={i} style={style} />;
      })}
    </span>
  );
}

function Avatar({ account, fallback, size }: { account?: string; fallback: string; size: number }) {
  // the fixture's keys differ between server and client: draw the face after mount
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- prototype
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  if (account) return <PlayerAvatar account={account} size={size} />;
  return <Image src={avatarFor(fallback)} alt="" width={size} height={size} />;
}

function Score({ value, num, delay }: { value: string; num: number | null; delay: number }) {
  if (num === null) return <>{value}</>;
  return <DelayedCount value={num} delay={delay} />;
}

/** CountUp from 0, started after `delay` (CSS can't count). */
function DelayedCount({ value, delay, duration = 1100 }: { value: number; delay: number; duration?: number }) {
  const [target, setTarget] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setTarget(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return <CountUp value={target} from={0} duration={duration} />;
}

function PendingLine({ won }: { won: boolean }) {
  if (!won) return null;
  return (
    <div className="rp-pending">
      <Link className="mr-pending" href="/wallet">
        Pending · redeemable as their yield lands <span aria-hidden="true">→</span>
      </Link>
      <SimulatedYieldLabel align="center" />
    </div>
  );
}

function Copy({ p }: { p: P }) {
  const d = derive(p);
  if (p.backed && p.role === "player") return <p className="mr-copy strong">You never owe anything, win or lose: your Backer&apos;s Gemas funded this entry.</p>;
  if (d.lost && p.role === "player") return <p className="mr-copy">Your entry went to the winner. Your Principal was never in play.</p>;
  if (p.outcome === "draw") return <p className="mr-copy">Equal scores: both entries were returned.</p>;
  if (p.outcome === "refunded") return <p className="mr-copy">The Match ended without a result and your entry was returned.</p>;
  return null;
}

function Actions({ p, className }: { p: P; className?: string }) {
  const d = derive(p);
  return (
    <div className={`mr-actions rp-actions${className ? ` ${className}` : ""}${d.lost ? " lost" : ""}`}>
      {p.role === "backer" ? (
        <Button variant="money" size="lg" href="/backing">Back a Player</Button>
      ) : (
        <Button variant="money" size="lg" href={p.playAgainHref}>Play again</Button>
      )}
      <Button size="lg" href="/lobby">Lobby</Button>
      <Button size="lg" href="/wallet">Wallet</Button>
    </div>
  );
}

/* ———————————————————— A: today's card, choreographed ———————————————————— */

function VariantA(p: P) {
  const d = derive(p);
  const rules = RULES[p.game];
  const [mine, theirs] = d.nums ?? [0, 0];
  return (
    <div className={`stack-lg mr rp-a ${p.outcome}`}>
      <h1 className="sr-only">Match result</h1>
      <section className={`cut cut-frame mr-frame rp-a-frame${d.won ? " won" : ""}`} aria-label={`Match result: ${d.status}`}>
        <span className="rp-a-sweep" aria-hidden="true" />
        <div className="mr-mid">
          <p className="mr-game rp-in" style={{ "--d": "120ms" } as Css}>{GAME_NAMES[p.game]} · {rules.chip}</p>
          <div className={`mr-status ${d.status.toLowerCase()} rp-a-status`}>
            <span className="mr-status-icon rp-a-stamp"><d.Icon /></span>
            <span className="rp-a-word">{d.status}</span>
            <span className="rp-a-ring" aria-hidden="true" />
          </div>

          <div className="mr-amount-wrap rp-a-amount">
            {d.won && (
              <>
                <span className="rp-rays" aria-hidden="true" />
                <Shards delay={900} />
              </>
            )}
            {d.amountLabel && <span className="mr-amount-label">{d.amountLabel}</span>}
            {d.neutral ? (
              <div className="mr-neutral rp-a-neutral">
                <b>{p.outcome === "draw" ? "Entry returned" : "Entry refunded"}</b>
                <span className="mr-neutral-amt"><GemaMark size={30} /> <Odo text={fmtGemas(p.entry)} delay={500} /> Gemas</span>
              </div>
            ) : (
              <div className={`mr-amount${d.won ? " won" : " rp-a-lost"}`}>
                {d.won && <span className="rp-a-gem"><GemaMark size={150} /></span>}
                <span className="mr-figure"><Odo text={d.amount} delay={d.won ? 700 : 450} className={d.won ? "facet" : ""} /></span>
                <span className="mr-unit rp-in" style={{ "--d": d.won ? "1500ms" : "1200ms" } as Css}>Gemas</span>
              </div>
            )}
          </div>

          <div className="rp-in" style={{ "--d": "1700ms" } as Css}>
            <PendingLine won={d.won} />
            <Copy p={p} />
          </div>
          {d.points > 0 && (
            <p className="rp-points rp-in" style={{ "--d": "1900ms" } as Css}>
              <b>+{d.points}</b> Season points · <Link href="/leaderboard">Leaderboard</Link>
            </p>
          )}

          {p.scores && (
            <div className="cut cut-card mr-scores rp-rise" style={{ "--d": "1300ms" } as Css}>
              <div className={d.nums && mine > theirs ? "rp-hi" : ""}>
                <span>{d.youLabel}</span>
                <b><Score value={p.scores[0]} num={d.nums ? mine : null} delay={1300} /></b>
              </div>
              <div className={d.nums && theirs > mine ? "rp-hi" : ""}>
                <span>Opponent</span>
                <b className="tnum dim"><Score value={p.scores[1]} num={d.nums ? theirs : null} delay={1300} /></b>
              </div>
            </div>
          )}
          {p.scoreNote && <p className="note">{p.scoreNote}</p>}

          <div className="cut cut-card mr-fees rp-rise" style={{ "--d": "1450ms" } as Css}>
            <div>
              <span>Entry</span>
              <b><GemaMark size={26} /> {fmtGemas(p.entry)} <small>Gemas</small></b>
            </div>
            <div>
              <span>Fee</span>
              <b><GemaMark size={26} /> {fmtGemas(d.fee)} <small>Gemas</small></b>
            </div>
          </div>
          {p.split && <div className="mr-split rp-rise" style={{ "--d": "1600ms" } as Css}>{p.split}</div>}
        </div>
      </section>
      <div className="rp-rise" style={{ "--d": "1800ms" } as Css}>
        <Actions p={p} />
      </div>
      {p.children}
    </div>
  );
}

/* ———————————————————— B: face-off, the Pot flies to the winner ———————————————————— */

function VariantB(p: P) {
  const d = derive(p);
  const rules = RULES[p.game];
  const [mine, theirs] = d.nums ?? [0, 0];
  const total = Math.max(1, mine + theirs);
  // where the Pot goes: -1 = your seat, 1 = theirs, 0 = splits back to both
  const dir = d.won ? -1 : d.lost ? 1 : p.outcome === "refunded" ? -1 : 0;
  const you = d.won ? "win" : d.lost ? "lose" : "even";
  const them = d.won ? "lose" : d.lost ? "win" : "even";
  const headline = d.won ? (p.role === "backer" ? "Your Player won" : "You won") : d.lost ? (p.role === "backer" ? "Your Player lost" : "You lost") : p.outcome === "draw" ? "Dead heat" : "No result";
  const potLeft = d.pot - d.fee;
  return (
    <div className={`rp-b ${p.outcome}`} style={{ "--dir": dir } as Css}>
      <h1 className="sr-only">Match result: {d.status}</h1>
      <header className="rp-b-head">
        <span className="enter-kicker rp-in">{GAME_NAMES[p.game]} · {rules.chip}</span>
        <h2 className="rp-b-title">
          <span className={`mr-status-icon rp-b-icon ${d.status.toLowerCase()}`}><d.Icon /></span>
          <span className="rp-b-words">{headline}</span>
        </h2>
      </header>

      <div className="rp-b-arena">
        <span className="rp-b-spot" aria-hidden="true" />
        <figure className={`rp-b-seat you ${you}`}>
          {d.won && <span className="rp-b-crown">Winner</span>}
          <span className="cut enter-av rp-b-av"><Avatar account={p.players?.[0]} fallback="you" size={132} /></span>
          <figcaption>{d.youLabel}</figcaption>
          {p.scores && <b className="rp-b-score"><Score value={p.scores[0]} num={d.nums ? mine : null} delay={350} /></b>}
          {d.won && <span className="rp-b-gain"><GemaMark size={22} /> +{fmtGemas(potLeft)}</span>}
          {d.neutral && <span className="rp-b-gain even"><GemaMark size={22} /> {fmtGemas(p.entry)}</span>}
        </figure>

        <div className="rp-b-mid">
          <div className="cut cut-card enter-plaque rp-b-pot">
            <span className="enter-label">Pot</span>
            <span className="rp-b-potamt"><GemaMark size={26} /> <DelayedCount value={d.pot} delay={0} duration={600} /></span>
            {d.fee > 0 && <small className="rp-b-fee">−{fmtGemas(d.fee)} Fees</small>}
          </div>
          <span className="rp-b-vs" aria-hidden="true">VS</span>
          {d.won && <Shards n={18} delay={2250} />}
        </div>

        <figure className={`rp-b-seat them ${them}`}>
          {d.lost && <span className="rp-b-crown">Winner</span>}
          <span className="cut enter-av rp-b-av"><Avatar account={p.players?.[1]} fallback="opponent" size={132} /></span>
          <figcaption>Opponent</figcaption>
          {p.scores && <b className="rp-b-score dim"><Score value={p.scores[1]} num={d.nums ? theirs : null} delay={350} /></b>}
          {d.lost && <span className="rp-b-gain them"><GemaMark size={22} /> +{fmtGemas(potLeft)}</span>}
          {p.outcome === "draw" && <span className="rp-b-gain even"><GemaMark size={22} /> {fmtGemas(p.entry)}</span>}
        </figure>

        {d.nums && (
          <div className="rp-b-race" aria-hidden="true">
            <i className="you" style={{ "--w": `${(mine / total) * 100}%` } as Css} />
            <i className="them" style={{ "--w": `${(theirs / total) * 100}%` } as Css} />
          </div>
        )}
      </div>

      <div className="rp-b-net">
        {d.amountLabel && <span className="mr-amount-label">{d.amountLabel}</span>}
        <span className={`rp-b-netfig${d.won ? " won" : ""}`}>
          <Odo text={d.amount} delay={2300} className={d.won ? "facet" : ""} /> <small>Gemas{d.neutral ? " back" : ""}</small>
        </span>
        <div className="rp-in" style={{ "--d": "2700ms" } as Css}>
          <PendingLine won={d.won} />
          <Copy p={p} />
          {d.points > 0 && <p className="rp-points"><b>+{d.points}</b> Season points · <Link href="/leaderboard">Leaderboard</Link></p>}
        </div>
        {p.split && <div className="mr-split rp-in" style={{ "--d": "2800ms" } as Css}>{p.split}</div>}
        <p className="rp-b-fine rp-in" style={{ "--d": "2800ms" } as Css}>Entry {fmtGemas(p.entry)} each · Fees {fmtGemas(d.fee)} Gemas</p>
      </div>

      <div className="rp-rise" style={{ "--d": "2900ms" } as Css}>
        <Actions p={p} />
      </div>
      {p.children}
    </div>
  );
}

/* ———————————————————— C: poster over the game's art ———————————————————— */

const HERO = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero } as const;

function VariantC(p: P) {
  const d = derive(p);
  const rules = RULES[p.game];
  const word = d.won ? "You won" : d.lost ? "You lost" : p.outcome === "draw" ? "Draw" : "Refunded";
  const letters = [...word.toUpperCase()];
  const [mine, theirs] = d.nums ?? [0, 0];
  const tiles: { k: string; v: ReactNode; on?: boolean }[] = [];
  if (p.scores) {
    tiles.push({ k: d.youLabel, v: <Score value={p.scores[0]} num={d.nums ? mine : null} delay={1200} />, on: d.nums ? mine > theirs : d.won });
    tiles.push({ k: "Opponent", v: <Score value={p.scores[1]} num={d.nums ? theirs : null} delay={1200} />, on: d.nums ? theirs > mine : d.lost });
  }
  tiles.push({ k: "Entry", v: <><GemaMark size={22} /> {fmtGemas(p.entry)}</> });
  tiles.push({ k: "Fee", v: <><GemaMark size={22} /> {fmtGemas(d.fee)}</> });
  if (d.points > 0) tiles.push({ k: "Season points", v: `+${d.points}` });

  return (
    <div className={`rp-c ${p.outcome}`}>
      <h1 className="sr-only">Match result: {d.status}</h1>
      <section className="cut cut-frame rp-c-poster" aria-label={`Match result: ${d.status}`}>
        <Image className="rp-c-art" src={HERO[p.game]} alt="" fill sizes="(min-width: 1024px) 1100px, 100vw" priority />
        <span className="rp-c-shade" aria-hidden="true" />
        {d.won && <Shards n={34} kind="rain" delay={600} />}
        <div className="rp-c-copy">
          <span className="enter-kicker rp-in" style={{ "--d": "100ms" } as Css}>
            <span className={`mr-status-icon rp-c-icon ${d.status.toLowerCase()}`}><d.Icon /></span>
            {GAME_NAMES[p.game]} · {rules.chip}
          </span>
          <p className="rp-c-word" aria-hidden="true">
            {letters.map((c, i) => (
              <span key={i} style={{ "--i": i } as Css}>{c === " " ? " " : c}</span>
            ))}
          </p>
          <div className="rp-c-amount">
            {d.amountLabel && <span className="mr-amount-label">{d.amountLabel}</span>}
            <span className={`rp-c-fig${d.won ? " won" : ""}`}>
              {!d.lost && <GemaMark size={64} />}
              <Odo text={d.amount} delay={d.won ? 650 : 500} className={d.won ? "facet" : ""} />
              <small>Gemas{d.neutral ? " back" : ""}</small>
            </span>
          </div>
          <div className="rp-in" style={{ "--d": "1400ms" } as Css}>
            <PendingLine won={d.won} />
            <Copy p={p} />
          </div>
        </div>
      </section>

      <div className="rp-c-strip">
        {tiles.map((t, i) => (
          <div key={t.k} className={`cut cut-card rp-c-tile rp-rise${t.on ? " on" : ""}`} style={{ "--d": `${1100 + i * 90}ms` } as Css}>
            <span>{t.k}</span>
            <b>{t.v}</b>
          </div>
        ))}
      </div>
      {p.split && <div className="mr-split rp-rise" style={{ "--d": "1600ms" } as Css}>{p.split}</div>}
      <div className="rp-rise" style={{ "--d": "1700ms" } as Css}>
        <Actions p={p} />
      </div>
      {p.children}
    </div>
  );
}

export function ResultVariant({ v, ...p }: P & { v: Exclude<ResultVariantKey, "now"> }) {
  if (v === "B") return <VariantB {...p} />;
  if (v === "C") return <VariantC {...p} />;
  return <VariantA {...p} />;
}
