"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Button, CheckIcon, CountUp, GemaMark, GemaUsd, MinusIcon, SimulatedYieldLabel, XIcon, type BustName } from "@/components/ui";
import { art } from "@/lib/art";
import { pointsForWin } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import type { GameId } from "@/lib/mock";
import { GAME_NAMES } from "@/lib/mock";
import { postUrl, winPath, winShareText } from "@/lib/win-card";
import { MomentOverlay } from "./MomentOverlay";
import { Odometer, Shards } from "./ResultMotion";
import "./match.css";

export type Outcome = "won" | "lost" | "draw" | "refunded";

export interface MatchResultProps {
  game: GameId;
  outcome: Outcome;
  /** The Gema change for whoever is looking (the Player's, or the Backer's when `role` is backer). */
  delta: number;
  entry: number;
  /** Platform + Studio + Leaderboard Fee taken from the Pot, in Gemas. */
  fee: number;
  role: "player" | "backer";
  backed: boolean;
  /** Final scores as shown: [yours, opponent's]. Null when the Match has none (refund). */
  scores: [string, string] | null;
  scoreNote?: string;
  playAgainHref: string;
  /** Show the win overlay once per key (the Match id); without one it shows on every mount. */
  momentKey?: string;
  /** The Match id: a Player's win can be shared as a card at /win/<id>. */
  matchId?: string;
  /** How a Backing paid out (BackingSplit), for backed Matches. */
  split?: ReactNode;
  /** Extra footer content (transactions, notes). */
  children?: ReactNode;
}

export const RULES: Record<GameId, { chip: string; line: string }> = {
  "block-puzzle": { chip: "Same pieces", line: "90 seconds · higher score wins" },
  holdem: { chip: "Heads-up", line: "Turbo blinds · last stack standing" },
  "trading-duel": { chip: "Live prices", line: "2.5 minutes · more points wins" },
};

const HERO: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero };

type Css = CSSProperties & Record<`--${string}`, string | number>;

/** The moment overlay's bust: only for wins (a Player's, or a Backer's backed win). Nothing else gets the overlay. */
function momentBust(p: MatchResultProps): { bust: BustName; title: string } | null {
  if (p.outcome !== "won") return null;
  if (p.role === "backer" && p.backed) return { bust: "duoWin", title: "Backed win" };
  return p.role === "player" ? { bust: "himWin", title: "You won" } : null;
}

/** A score that counts up from 0 once `run` is set and `delay` has passed; text scores (Hold'em, Trading Duel) show as they are. */
function Score({ value, run, delay }: { value: string; run: boolean; delay: number }) {
  const n = Number(value);
  const [target, setTarget] = useState(0);
  useEffect(() => {
    if (!run) return;
    const t = setTimeout(() => setTarget(n), delay);
    return () => clearTimeout(t);
  }, [n, run, delay]);
  if (value === "" || !Number.isFinite(n)) return <>{value}</>;
  return <CountUp value={target} from={0} duration={1100} />;
}

/**
 * The Match result, every game: a poster over the game's key art (the outcome in giant letters, the Gema change rolling
 * in), a strip of tiles (scores, entry, fee, Season points) and the actions. A win first gets the short character
 * overlay (MomentOverlay); the poster's motion waits for it to close. A Player's loss has the calm `him-lose` bust on
 * the poster itself, in colour over the drained art: no overlay, nothing between the Player and Play again. Won Gemas are claims on the loser's Source, so a
 * win always says so and links to the Wallet: never implies cash in hand. Reduced motion shows the finished screen.
 */
export function MatchResult(p: MatchResultProps) {
  const { outcome, role, backed, delta } = p;
  const won = outcome === "won";
  const lost = outcome === "lost";
  const neutral = !won && !lost;
  const moment = momentBust(p);
  // the poster holds its first frame while the win overlay shows
  const [held, setHeld] = useState(moment !== null);

  const status = won ? "Won" : lost ? "Lost" : outcome === "draw" ? "Draw" : "Refunded";
  const Icon = won ? CheckIcon : lost ? XIcon : MinusIcon;
  const word = won ? "You won" : lost ? "You lost" : status;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const amount = neutral ? fmtGemas(p.entry) : `${sign}${fmtGemas(Math.abs(delta))}`;
  const amountLabel = backed ? (role === "backer" ? "Your return" : "Your share") : null;
  const points = won && role === "player" ? pointsForWin(p.entry) : 0;

  const nums = p.scores?.map(Number);
  const numeric = !!nums && nums.every(Number.isFinite);
  const tiles: { k: string; v: ReactNode; on?: boolean }[] = [];
  if (p.scores) {
    const [mine, theirs] = nums ?? [0, 0];
    tiles.push({ k: role === "backer" ? "Your Player" : "You", v: <Score value={p.scores[0]} run={!held} delay={1200} />, on: numeric ? mine > theirs : won });
    tiles.push({ k: "Opponent", v: <Score value={p.scores[1]} run={!held} delay={1200} />, on: numeric ? theirs > mine : lost });
  }
  tiles.push({ k: "Entry", v: <><GemaMark size={22} /> {fmtGemas(p.entry)}</> });
  tiles.push({ k: "Fee", v: <><GemaMark size={22} /> {fmtGemas(neutral ? 0 : p.fee)}</> });
  if (points > 0) tiles.push({ k: "Season points", v: `+${points}` });

  return (
    <>
      <div className={`mr ${outcome}${held ? " held" : ""}`}>
        <h1 className="sr-only">Match result: {status}</h1>

        <section className="cut cut-frame mr-poster" aria-label={`Match result: ${status}`}>
          <Image className="mr-art" src={HERO[p.game]} alt="" fill sizes="(min-width: 1024px) 1100px, 100vw" priority />
          <span className="mr-shade" aria-hidden="true" />
          {won && <Shards n={34} kind="rain" delay={600} />}
          {lost && role === "player" && (
            <Image className="mr-char" src={art.guide.himLose.src} alt="" width={art.guide.himLose.w} height={art.guide.himLose.h} sizes="(min-width: 640px) 420px, 140px" />
          )}
          <div className="mr-copyblock">
            <span className="mr-kicker mr-in" style={{ "--d": "100ms" } as Css}>
              <span className={`mr-status-icon ${outcome}`}><Icon /></span>
              <span>{status} · {GAME_NAMES[p.game]}</span>
            </span>
            <p className="mr-word" aria-hidden="true">
              {[...word.toUpperCase()].map((c, i) => (
                <span key={i} style={{ "--i": i } as Css}>{c === " " ? " " : c}</span>
              ))}
            </p>
            <div className="mr-amount">
              {amountLabel && <span className="mr-amount-label">{amountLabel}</span>}
              <span className="mr-fig">
                {!lost && <GemaMark size={64} />}
                <Odometer text={amount} delay={won ? 650 : 500} className={won ? "facet" : ""} />
                <small>Gemas{neutral ? " back" : ""}</small>
              </span>
              <GemaUsd className="mr-usd" value={neutral ? p.entry : Math.abs(delta)} />
            </div>
            <div className="mr-in mr-notes" style={{ "--d": "1400ms" } as Css}>
              {won && (
                <>
                  <Link className="mr-pending" href="/wallet">
                    Pending · redeemable as their yield lands <span aria-hidden="true">→</span>
                  </Link>
                  <SimulatedYieldLabel />
                </>
              )}
              {backed && role === "player" ? (
                <p className="mr-copy strong">You never owe anything, win or lose: your Backer&apos;s Gemas funded this entry.</p>
              ) : lost && role === "player" ? (
                <p className="mr-copy">Your entry went to the winner. Your Principal was never in play.</p>
              ) : outcome === "draw" ? (
                <p className="mr-copy">Equal scores: both entries were returned.</p>
              ) : outcome === "refunded" ? (
                <p className="mr-copy">The Match ended without a result and your entry was returned.</p>
              ) : null}
            </div>
          </div>
        </section>

        <div className="mr-tiles">
          {tiles.map((t, i) => (
            <div key={t.k} className={`cut cut-card mr-tile mr-rise${t.on ? " on" : ""}`} style={{ "--d": `${1100 + i * 90}ms` } as Css}>
              <span>{t.k}</span>
              <b>{t.v}</b>
            </div>
          ))}
        </div>
        {p.scoreNote && <p className="note">{p.scoreNote}</p>}
        {p.split && <div className="mr-split mr-rise" style={{ "--d": "1600ms" } as Css}>{p.split}</div>}

        <div className="mr-actions mr-rise" style={{ "--d": "1700ms" } as Css}>
          {role === "backer" ? (
            <Button variant="money" size="lg" href="/backing">Back a Player</Button>
          ) : (
            <Button variant="money" size="lg" href={p.playAgainHref}>Play again</Button>
          )}
          {won && role === "player" && p.matchId && (
            <Button
              size="lg"
              onClick={() => {
                const url = `${window.location.origin}${winPath(p.matchId!)}`;
                window.open(postUrl(winShareText({ game: p.game, gemas: delta, entry: p.entry }), url), "_blank", "noopener,noreferrer");
              }}
            >
              Share your win
            </Button>
          )}
          <Button size="lg" href="/lobby">Lobby</Button>
          <Button size="lg" href="/wallet">Wallet</Button>
        </div>
        {p.children}
      </div>
      {moment && <MomentOverlay bust={moment.bust} title={moment.title} amount={Math.abs(delta)} momentKey={p.momentKey} onDone={() => setHeld(false)} />}
    </>
  );
}
