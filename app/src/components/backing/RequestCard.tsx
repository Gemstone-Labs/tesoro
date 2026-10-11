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
import { Pnl } from "./Pnl";
import "./request-card.css";

/**
 * A Player's live Request on the Backing board, a poster like the Lobby's Player card: their animal
 * over the Game's art, the name, record (win rate, W, L), P&L, then the entry they ask for.
 */
export function RequestCard({
  r,
  action,
  nowMs,
  selected = false,
  id,
}: {
  r: ChainRequest;
  /** Beside "Asks for"; left out where the card only shows who is being backed (the Offer drawer). */
  action?: ReactNode;
  nowMs?: number;
  selected?: boolean;
  id?: string;
}) {
  const name = usePlayerLabel(r.player);
  const { matches, wins } = r.record;
  const left = timeLeft(r.expiresAt, nowMs);
  return (
    <article id={id} className={`cut cut-card rq${selected ? " selected" : ""}`} aria-label={`${name}, ${GAME_NAMES[r.game]}`}>
      <div className="rq-face">
        <Image className="rq-art" src={art.hero[r.game]} alt="" fill sizes="(min-width: 1100px) 440px, 100vw" />
        <span className="rq-game">{GAME_NAMES[r.game]}</span>
        <span className="rq-time mono" aria-label={left}>
          <ClockIcon width={12} height={12} />
          {left.replace(" left", "")}
        </span>
        <AccountLink account={r.player} decorative className="cut cut-btn avatar rq-avatar">
          <PlayerAvatar account={r.player} size={264} />
        </AccountLink>
      </div>
      <div className="rq-body">
        <strong>
          <AccountLink account={r.player} />
        </strong>
        {matches ? (
          <>
            <dl className="rq-stats">
              <div>
                <dt>Won</dt>
                <dd>{Math.round((wins / matches) * 100)}%</dd>
              </div>
              <div>
                <dt>W</dt>
                <dd>{wins}</dd>
              </div>
              <div>
                <dt>L</dt>
                <dd>{matches - wins}</dd>
              </div>
            </dl>
            <Pnl deltas={r.pnl} />
          </>
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
