"use client";

/**
 * PROTOTYPE ONLY: three takes on the "Back a player" card, switched by `?variant=` on /lobby.
 * Question: what should a Request card lead with so a Backer can decide at a glance?
 * Throwaway: fold the winner into BackPlayerRail properly and delete this file.
 */
import Image from "next/image";
import type { ReactNode } from "react";
import type { ChainRequest } from "@/lib/chain/backing";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { art } from "@/lib/art";
import { ClockIcon, GemaMark } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar } from "@/components/account/Player";
import "./player-card.prototype.css";

export const PLAYER_CARD_VARIANTS = [
  { key: "A", name: "Record first" },
  { key: "B", name: "Game banner" },
  { key: "C", name: "Win ring, compact" },
  { key: "now", name: "Current card" },
] as const;
export type PlayerCardVariant = (typeof PLAYER_CARD_VARIANTS)[number]["key"];

type Props = { r: ChainRequest; action: ReactNode };

const HERO = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero } as const;

function stats(r: ChainRequest) {
  const { matches, wins } = r.record;
  return { matches, wins, losses: matches - wins, pct: matches ? Math.round((wins / matches) * 100) : 0 };
}

function Avatar({ r, className, size }: { r: ChainRequest; className: string; size: number }) {
  return (
    <AccountLink account={r.player} decorative className={`cut cut-btn avatar ${className}`}>
      <PlayerAvatar account={r.player} size={size} />
    </AccountLink>
  );
}

function Left({ r }: { r: ChainRequest }) {
  return (
    <span className="pc-time">
      <ClockIcon width={13} height={13} />
      {timeLeft(r.expiresAt)}
    </span>
  );
}

/** A: the record is the pitch. Big win rate, sample size and W–L, a neutral bar, then the ask. */
export function CardRecord({ r, action }: Props) {
  const s = stats(r);
  return (
    <article className="cut cut-card pcA">
      <header className="pcA-head">
        <Avatar r={r} className="pcA-av" size={112} />
        <div className="pcA-who">
          <strong>
            <AccountLink account={r.player} />
          </strong>
          <span>{GAME_NAMES[r.game]}</span>
        </div>
        <Left r={r} />
      </header>
      {s.matches ? (
        <div className="pcA-rec">
          <dl className="pcA-stats">
            <div>
              <dt>Won</dt>
              <dd>{s.pct}%</dd>
            </div>
            <div>
              <dt>Matches</dt>
              <dd>{s.matches}</dd>
            </div>
            <div>
              <dt>W – L</dt>
              <dd>
                {s.wins}–{s.losses}
              </dd>
            </div>
          </dl>
          <span className="pcA-bar" aria-hidden="true">
            <i style={{ width: `${s.pct}%` }} />
          </span>
        </div>
      ) : (
        <p className="pcA-new">New Player · no settled Matches yet</p>
      )}
      <footer className="pcA-foot">
        <div>
          <span>Asks for</span>
          <b>
            <GemaMark size={20} />
            {fmtGemas(r.entry)}
          </b>
        </div>
        {action}
      </footer>
    </article>
  );
}

/** B: the Game's art carries the colour; the avatar sits on the art's edge like a profile header. */
export function CardBanner({ r, action }: Props) {
  const s = stats(r);
  return (
    <article className="cut cut-card pcB">
      <div className="pcB-art">
        <Image src={HERO[r.game]} alt="" fill sizes="440px" />
        <span className="pcB-game">{GAME_NAMES[r.game]}</span>
        <Left r={r} />
      </div>
      <div className="pcB-body">
        <Avatar r={r} className="pcB-av" size={140} />
        <div className="pcB-who">
          <strong>
            <AccountLink account={r.player} />
          </strong>
          <span>{s.matches ? `${s.wins} of ${s.matches} won · ${s.pct}%` : "New Player · no settled Matches"}</span>
        </div>
      </div>
      <footer className="pcB-foot">
        <b>
          <GemaMark size={20} />
          {fmtGemas(r.entry)}
          <small>entry</small>
        </b>
        {action}
      </footer>
    </article>
  );
}

/** C: same footprint as today; the avatar's cut frame doubles as the win-rate meter. */
export function CardRing({ r, action }: Props) {
  const s = stats(r);
  const S = 84;
  const c = 18;
  const i = 2; // half the stroke
  const path = `M${S / 2} ${i} L${S - c} ${i} L${S - i} ${c} L${S - i} ${S - c} L${S - c} ${S - i} L${c} ${S - i} L${i} ${S - c} L${i} ${c} L${c} ${i} Z`;
  return (
    <article className="cut cut-card pcC">
      <div className="pcC-ring">
        <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} aria-hidden="true">
          <path d={path} className="track" pathLength={100} />
          {s.matches > 0 && <path d={path} className="fill" pathLength={100} strokeDasharray={`${s.pct} 100`} />}
        </svg>
        <Avatar r={r} className="pcC-av" size={128} />
        <span className="pcC-pct">{s.matches ? `${s.pct}%` : "New"}</span>
      </div>
      <div className="pcC-info">
        <strong>
          <AccountLink account={r.player} />
        </strong>
        <span>{GAME_NAMES[r.game]}</span>
        <span className="pcC-rec">
          {s.matches ? (
            <>
              <b>{s.wins}</b>W · <b>{s.losses}</b>L
            </>
          ) : (
            "No settled Matches yet"
          )}
        </span>
      </div>
      <div className="pcC-side">
        <b>
          <GemaMark size={18} />
          {fmtGemas(r.entry)}
        </b>
        {action}
        <Left r={r} />
      </div>
    </article>
  );
}
