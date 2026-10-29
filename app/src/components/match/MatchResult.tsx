"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Button, CheckIcon, GemaMark, GemaUsd, MinusIcon, XIcon, type BustName } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { accountKeyOf } from "@/lib/chain/account-key";
import { nextStep, ordinal, pts, seasonStanding, type SeasonStanding } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { fmtGemas } from "@/lib/format";
import { setFullScreen } from "@/games/fx";
import { AddFriendButton } from "@/components/friends/AddFriendButton";
import type { GameId } from "@/lib/mock";
import { GAME_NAMES } from "@/lib/mock";
import { postUrl, winPath, winShareText } from "@/lib/win-card";
import { refundCopy } from "@/lib/chain/match-status";
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
  /** Platform + Studio + Leaderboard Fee taken from the Pot, in Gemas; null when it is not known (no Fee tile). */
  fee: number | null;
  role: "player" | "backer";
  backed: boolean;
  /** A line under the tiles about how the game ended (Trading Duel: the closing price). */
  scoreNote?: string;
  playAgainHref: string;
  /** The opponent of this Match, when known: Add a friend. */
  opponent?: string | null;
  /** Season points this Match gave the Player, as the history settled them; absent while the Match is not in the history yet. */
  points?: number | null;
  /** This page sent the cancel that ended the Match. */
  cancelled?: boolean;
  /** Show the win overlay once per key (the Match id); without one it shows on every mount. */
  momentKey?: string;
  /** The Match id. */
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
  vanguard: { chip: "Hidden ranks", line: "10 seconds a move · capture the Supply Truck" },
};

const HERO: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero, vanguard: art.vanguardHero };

type Css = CSSProperties & Record<`--${string}`, string | number>;

/** The moment overlay's bust: only for wins (a Player's, or a Backer's backed win). Nothing else gets the overlay. */
function momentBust(p: MatchResultProps): { bust: BustName; title: string } | null {
  if (p.outcome !== "won") return null;
  if (p.role === "backer" && p.backed) return { bust: "duoWin", title: "Backed win" };
  return p.role === "player" ? { bust: "himWin", title: "You won" } : null;
}

/** Where the signed-in Player stands in the Season: `loading` until the Leaderboard has been read (or failed), `standing` null while unranked or the Leaderboard Fee is off. */
function useStanding(): { loading: boolean; standing: SeasonStanding | null } {
  const { auth, snapshot } = useAccount();
  const me = auth.status === "signed-in" ? (snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null)) : null;
  const { data, forMe, error } = useLeaderboard(me);
  const ready = !me || (forMe && !!data) || error;
  return { loading: !ready, standing: me && forMe && data && data.feeBps > 0 ? seasonStanding(data, me) : null };
}

/** The Season tile, after a loss too: the points this Match gave (0 after a loss; unknown until the history settles them) and the Player's Leaderboard position, blank while loading, or "Not ranked yet". */
function SeasonTile({ points, delay }: { points: number | null; delay: string }) {
  const { loading, standing } = useStanding();
  const step = standing ? nextStep(standing) : null;
  const body = (
    <>
      <span>{points === null ? "Season" : `Season · +${pts(points)}`}</span>
      {loading ? <b aria-busy="true">&nbsp;</b> : <b>{standing?.rank ? ordinal(standing.rank) : "Not ranked yet"}</b>}
      {step && <small>{step} <span aria-hidden="true">→</span></small>}
    </>
  );
  const cls = "cut cut-card mr-tile mr-rise";
  const style = { "--d": delay } as Css;
  return step ? <Link href="/leaderboard" className={`${cls} link`} style={style}>{body}</Link> : <div className={cls} style={style}>{body}</div>;
}

/**
 * The Match result, every game: a poster over the game's key art (the outcome in giant letters, the Gema change rolling
 * in), a strip of tiles (Season points, fee) and the actions. A win first gets the short character
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
  // The game's window cover ends with the game: the result sits inside the app shell (sidebar, bottom navbar).
  useEffect(() => setFullScreen(false), []);

  const status = won ? "Won" : lost ? "Lost" : outcome === "draw" ? "Draw" : "Refunded";
  const Icon = won ? CheckIcon : lost ? XIcon : MinusIcon;
  const word = won ? "You won" : lost ? "You lost" : status;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const amount = neutral ? fmtGemas(p.entry) : `${sign}${fmtGemas(Math.abs(delta))}`;
  const amountLabel = backed ? (role === "backer" ? "Your return" : "Your share") : null;
  // After a win the points depend on the Season's cap per opponent, so they are shown only once the history has them.
  const points = !won || role !== "player" ? 0 : (p.points ?? null);

  const tiles: { k: string; v: ReactNode; season?: number | null }[] = [];
  if (role === "player") tiles.push({ k: "Season", v: null, season: points });
  if (p.fee !== null) tiles.push({ k: "Fee", v: <><GemaMark size={22} /> {fmtGemas(p.fee)}</> });

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
              {backed && role === "player" ? (
                <p className="mr-copy strong">You never owe anything, win or lose: your Backer&apos;s Gemas funded this entry.</p>
              ) : outcome === "draw" ? (
                <p className="mr-copy">Equal scores: both entries were returned.</p>
              ) : outcome === "refunded" ? (
                <p className="mr-copy">{refundCopy({ unjoined: !p.opponent, cancelled: !!p.cancelled })}</p>
              ) : null}
            </div>
            {won && role === "player" && p.matchId && (
              <div className="mr-in mr-share" style={{ "--d": "1500ms" } as Css}>
                <Button
                  size="lg"
                  onClick={() => {
                    const url = `${window.location.origin}${winPath(p.matchId!)}`;
                    window.open(postUrl(winShareText({ game: p.game, gemas: delta, entry: p.entry }), url), "_blank", "noopener,noreferrer");
                  }}
                >
                  Share your win
                </Button>
              </div>
            )}
          </div>
        </section>

        <div className="mr-tiles">
          {tiles.map((t, i) => t.season !== undefined ? (
            <SeasonTile key={t.k} points={t.season} delay={`${1100 + i * 90}ms`} />
          ) : (
            <div key={t.k} className="cut cut-card mr-tile mr-rise" style={{ "--d": `${1100 + i * 90}ms` } as Css}>
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
            <div className="mr-pair">
              <Button variant="money" size="lg" href={p.playAgainHref}>Play again</Button>
              {p.opponent && <AddFriendButton account={p.opponent} size="lg" />}
            </div>
          )}
        </div>
        {p.children}
      </div>
      {moment && <MomentOverlay bust={moment.bust} title={moment.title} amount={Math.abs(delta)} momentKey={p.momentKey} onDone={() => setHeld(false)} />}
    </>
  );
}
