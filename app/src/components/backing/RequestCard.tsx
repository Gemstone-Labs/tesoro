"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import type { ChainRequest } from "@/lib/chain/backing";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { ClockIcon, GemaMark } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import "./request-card.css";

const HERO = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero } as const;

/**
 * A Player's live Request: the Game's banner, the Player, their record (win rate with its sample
 * size, W–L) and the entry they ask for. Lobby "Back a player" and the Backing board.
 */
export function RequestCard({
  r,
  action,
  nowMs,
  selected = false,
  id,
}: {
  r: ChainRequest;
  action: ReactNode;
  nowMs?: number;
  selected?: boolean;
  id?: string;
}) {
  const name = usePlayerLabel(r.player);
  const { matches, wins } = r.record;
  const pct = matches ? Math.round((wins / matches) * 100) : 0;
  return (
    <article id={id} className={`cut cut-card rq${selected ? " selected" : ""}`} aria-label={`${name}, ${GAME_NAMES[r.game]}`}>
      <div className="rq-art">
        <Image src={HERO[r.game]} alt="" fill sizes="(min-width: 1100px) 440px, 100vw" />
        <span className="rq-game">{GAME_NAMES[r.game]}</span>
        <span className="rq-time">
          <ClockIcon width={13} height={13} />
          {timeLeft(r.expiresAt, nowMs)}
        </span>
      </div>
      <div className="rq-who">
        <AccountLink account={r.player} decorative className="cut cut-btn avatar rq-avatar">
          <PlayerAvatar account={r.player} size={152} />
        </AccountLink>
        <strong>
          <AccountLink account={r.player} />
        </strong>
      </div>
      <div className="rq-body">
        {matches ? (
          <div className="rq-rec">
            <dl>
              <div>
                <dt>Won</dt>
                <dd>{pct}%</dd>
              </div>
              <div>
                <dt>{matches === 1 ? "Match" : "Matches"}</dt>
                <dd>{matches}</dd>
              </div>
              <div>
                <dt>W – L</dt>
                <dd>
                  {wins}–{matches - wins}
                </dd>
              </div>
            </dl>
            <span className="rq-bar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
          </div>
        ) : (
          <p className="rq-new">New Player · no settled Matches yet</p>
        )}
        <footer className="rq-foot">
          <div>
            <span>Asks for</span>
            <b>
              <GemaMark size={20} />
              {fmtGemas(r.entry)}
            </b>
          </div>
          {action}
        </footer>
      </div>
    </article>
  );
}
