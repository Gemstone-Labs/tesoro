"use client";

import { useEffect, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { Button, CheckIcon, GemaMark, MinusIcon, Notice } from "@/components/ui";
import { feeGemas } from "@/lib/chain/ledger";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { gameQuery } from "@/lib/game-params";
import { assetIndexOf } from "@/lib/chain/match-id";
import { DuelSpectate } from "./DuelSpectate";
import { VanguardSpectate } from "@/games/vanguard/VanguardSpectate";
import { RULES } from "./MatchResult";
import "./match.css";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";

/** What a spectator cannot see while a Match is live, by Game. */
const SPECTATE_HIDDEN: Record<GameId, string> = { "block-puzzle": "Runs", holdem: "Cards", "trading-duel": "Positions", vanguard: "Ranks" };

/**
 * Someone else's Match, read-only: both Players (each leading to their Account), the result and the Pot. Open and live Matches are
 * re-read every few seconds until they finish; runs and hands stay hidden until settlement.
 */
export function MatchSpectate({ matchId, onSignIn }: { matchId: string; onSignIn?: () => void }) {
  const [m, setM] = useState<ChainMatch | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const next = await fetchMatch(BigInt(matchId), null).catch(() => undefined);
      if (!live) return;
      if (next !== undefined) setM(next);
      if (next === undefined || (next && (next.status === "open" || next.status === "active"))) timer = setTimeout(read, 5000);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [matchId]);

  const settledResult = m ? (m.session ? (m.session.settled ? m.session.result : null) : m.winner) : null;
  const winnerLabel = usePlayerLabel(m && m.status === "settled" && (settledResult === "opener" || settledResult === "joiner") ? m.sides[settledResult === "opener" ? 0 : 1]?.player : undefined);

  if (m === undefined) return <p className="status" role="status">Loading the Match…</p>;
  if (m === null) {
    return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  }

  const result = m.session ? (m.session.settled ? m.session.result : null) : m.winner;
  const winSeat = m.status === "settled" && (result === "opener" || result === "joiner") ? (result === "opener" ? 0 : 1) : null;
  const fee = Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps, m.fees.leaderboardBps));
  const payout = m.entry * 2 - fee;
  const scores = m.session && m.status === "settled" ? m.session.scores : null;
  const rules = RULES[m.game];

  const headline =
    winSeat !== null
      ? `${winnerLabel} won`
      : m.status === "settled"
        ? "Draw"
        : m.status === "refunded"
          ? "Refunded"
          : m.status === "open"
            ? "Waiting for an opponent"
            : "In play";
  const Icon = winSeat !== null ? CheckIcon : MinusIcon;

  const side = (i: 0 | 1) => {
    const s = m.sides[i];
    const mark = scores ? String(scores[i]) : m.game !== "block-puzzle" && winSeat !== null ? (winSeat === i ? "Won" : "Lost") : null;
    return (
      <div key={i}>
        {s ? (
          <>
            <PlayerAvatar className="mr-sp-av" account={s.player} size={56} />
            <AccountLink account={s.player} />
            {s.funder !== s.player && <small className="note">Backed by <PlayerName account={s.funder} /></small>}
          </>
        ) : (
          <span>No opponent yet</span>
        )}
        {mark && <b className={`tnum${scores ? (winSeat !== null && winSeat !== i ? " dim" : "") : winSeat === i ? " won" : " lost"}`}>{mark}</b>}
      </div>
    );
  };

  return (
    <div className="stack-lg mr">
      <section className={`cut cut-frame mr-frame${winSeat !== null ? " won" : ""}`} aria-label={`Match: ${headline}`}>
        <div className="mr-mid">
          <p className="mr-game">
            {GAME_NAMES[m.game]} · {rules.line}
          </p>
          <h1 className={`mr-status ${winSeat !== null ? "won" : "draw"}`}>
            <span className="mr-status-icon"><Icon /></span>
            {headline}
          </h1>

          {winSeat !== null && (
            <div className="mr-neutral">
              <span className="mr-neutral-amt">
                <GemaMark size={30} /> {fmtGemas(payout)} Gemas
              </span>
            </div>
          )}

          <div className="cut cut-card mr-scores mr-sp-players">
            {side(0)}
            {side(1)}
          </div>

          <div className="cut cut-card mr-fees">
            <div>
              <span>Entry</span>
              <b>
                <GemaMark size={26} /> {fmtGemas(m.entry)} <small>Gemas</small>
              </b>
            </div>
            <div>
              <span>Fee</span>
              <b>
                <GemaMark size={26} /> {fmtGemas(winSeat !== null ? fee : 0)} <small>Gemas</small>
              </b>
            </div>
          </div>

          {m.game === "trading-duel" && <DuelSpectate m={m} />}
          {m.game === "vanguard" && <VanguardSpectate m={m} />}

          <p className="mr-copy">
            {m.status === "open" || m.status === "active"
              ? `You are watching a Match you are not part of. ${SPECTATE_HIDDEN[m.game]} stay hidden until it settles.`
              : "You are viewing a Match you were not part of. The result is final."}
          </p>
        </div>
      </section>

      <div className="mr-actions">
        {onSignIn ? (
          <Button variant="money" size="lg" onClick={onSignIn}>Sign in to play</Button>
        ) : (
          <Button variant="money" size="lg" href={`/play/queue?${gameQuery(m.game, m.game === "trading-duel" ? assetIndexOf(m.id) : null)}entry=${m.entry}`}>
            Play {GAME_NAMES[m.game]}
          </Button>
        )}
        <Button size="lg" href="/lobby">Lobby</Button>
        <Button size="lg" href="/matches">All Matches</Button>
      </div>
    </div>
  );
}
