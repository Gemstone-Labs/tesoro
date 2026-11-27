"use client";

import { useEffect, useRef, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { Button, CheckIcon, GemaMark, MinusIcon, Notice } from "@/components/ui";
import { matchFee } from "@/lib/chain/ledger";
import { getBurst, getHoldem, getTradingDuel, getVanguard } from "@/lib/chain/client";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { gameQuery } from "@/lib/game-params";
import { DuelSpectate } from "./DuelSpectate";
import { EndStateNote } from "./EndStateNote";
import { isFinal, laterRead, readSpectated, spectateFee, spectateHeadline, spectateLine, spectateState, type Spectated } from "./spectate-state";
import { VanguardSpectate } from "@/games/vanguard/VanguardSpectate";
import { RULES } from "./MatchResult";
import "./match.css";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";

/** What a spectator cannot see while a Match is live, by Game. */
const SPECTATE_HIDDEN: Record<GameId, string> = { "block-puzzle": "Runs", holdem: "Cards", "trading-duel": "Positions", vanguard: "Ranks" };

/** The Pot line: the Fees a finished Match settled with (a closed Match keeps no rates), else the Fees at its rates. */
export function spectatorPot(m: ChainMatch): { fee: number; payout: number } {
  const fee = matchFee(m);
  return { fee, payout: m.entry * 2 - fee };
}

/** Whether the Match's Game has written its Assignment: the table it plays on. */
async function hasTable(m: ChainMatch): Promise<boolean> {
  const game = m.game === "block-puzzle" ? getBurst() : m.game === "holdem" ? getHoldem() : m.game === "trading-duel" ? getTradingDuel() : getVanguard();
  return (await game.readAssignment(m.address)) !== null;
}

/**
 * Someone else's Match, read-only: both Players (each leading to their Account), where the Match stands and the Pot. The Match
 * and its table are re-read every few seconds until it is settled or refunded; runs and hands stay hidden until settlement.
 */
export function MatchSpectate({ matchId, onSignIn }: { matchId: string; onSignIn?: () => void }) {
  const [seen, setSeen] = useState<Spectated | null | undefined>(undefined);
  const shown = useRef<Spectated | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    shown.current = undefined;
    const read = async () => {
      const next = await readSpectated(matchId, { fetchMatch: (id) => fetchMatch(id, null), tabled: hasTable, now: Date.now }, !!shown.current?.tabled);
      if (!live) return;
      const now = laterRead(shown.current, next);
      shown.current = now;
      setSeen(now);
      if (now === undefined || (now && !isFinal(spectateState(now.m, now.tabled)))) timer = setTimeout(read, 5000);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [matchId]);

  if (seen === undefined) return <p className="status" role="status">Loading the Match…</p>;
  if (seen === null) {
    return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  }
  return <SpectateView seen={seen} onSignIn={onSignIn} />;
}

/** The spectator's page for one read of the Match. */
export function SpectateView({ seen, onSignIn }: { seen: Spectated; onSignIn?: () => void }) {
  const { m } = seen;
  const state = spectateState(m, seen.tabled);
  const over = state === "settled" || state === "settling";
  const result = m.session ? (m.session.settled ? m.session.result : null) : m.winner;
  const winSeat = over && (result === "opener" || result === "joiner") ? (result === "opener" ? 0 : 1) : null;
  const winnerLabel = usePlayerLabel(winSeat !== null ? m.sides[winSeat]?.player : undefined);
  const { fee, payout } = spectatorPot(m);
  const feeLine = spectateFee(m, state);
  const scores = m.session && over ? m.session.scores : null;
  const rules = RULES[m.game];
  const headline = spectateHeadline(state, winSeat !== null ? winnerLabel : null);
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
              <span className="mr-neutral-label">Winner gains</span>
              <span className="mr-neutral-amt">
                <GemaMark size={30} /> +{fmtGemas(payout - m.entry)} Gemas
              </span>
              <span className="mr-sum">
                Pot {fmtGemas(m.entry * 2)} − Fee {fmtGemas(fee)} = {fmtGemas(payout)} to the winner, who put in {fmtGemas(m.entry)}
              </span>
            </div>
          )}

          <div className="cut cut-card mr-scores mr-sp-players">
            {side(0)}
            {side(1)}
          </div>

          <div className="cut cut-card mr-fees">
            <div>
              <span>Each entry</span>
              <b>
                <GemaMark size={26} /> {fmtGemas(m.entry)} <small>Gemas</small>
              </b>
            </div>
            {feeLine && (
              <div>
                <span>{feeLine.label}</span>
                <b>
                  <GemaMark size={26} /> {fmtGemas(feeLine.fee)} <small>Gemas</small>
                </b>
              </div>
            )}
          </div>

          {m.game === "trading-duel" && <DuelSpectate m={m} />}
          {m.game === "vanguard" && <VanguardSpectate m={m} />}
          <EndStateNote m={m} />

          <p className="mr-copy">{spectateLine(m, state, seen.at, SPECTATE_HIDDEN[m.game])}</p>
        </div>
      </section>

      <div className="mr-actions">
        {onSignIn ? (
          <Button variant="money" size="lg" onClick={onSignIn}>Sign in to play</Button>
        ) : (
          <Button variant="money" size="lg" href={`/play/queue?${gameQuery(m.game, m.game === "trading-duel" ? m.asset : null)}entry=${m.entry}`}>
            Play {GAME_NAMES[m.game]}
          </Button>
        )}
        <Button size="lg" href="/play">Back to games</Button>
        <Button size="lg" href="/matches">All Matches</Button>
      </div>
    </div>
  );
}
