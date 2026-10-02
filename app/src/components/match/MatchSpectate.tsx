"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Button, CheckIcon, GemaMark, MinusIcon } from "@/components/ui";
import { avatarFor } from "@/lib/art";
import { feeGemas } from "@/lib/chain/ledger";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { RULES } from "./MatchResult";
import "./match.css";

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/**
 * Someone else's Match, read-only: both Players, the result and the Pot. Open and live Matches are
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

  if (m === undefined) return <p className="status" role="status">Reading the Match from Solana devnet…</p>;
  if (m === null) {
    return (
      <div className="stack-lg mr">
        <h1 className="page-title">Match not found</h1>
        <p className="meta">No Match with that id on devnet.</p>
        <Button href="/">Lobby</Button>
      </div>
    );
  }

  const result = m.session ? (m.session.settled ? m.session.result : null) : m.winner;
  const winSeat = m.status === "settled" && (result === "opener" || result === "joiner") ? (result === "opener" ? 0 : 1) : null;
  const fee = Number(feeGemas(BigInt(m.entry), m.fees.platformBps, m.fees.studioBps));
  const payout = m.entry * 2 - fee;
  const scores = m.session && m.status === "settled" ? m.session.scores : null;
  const rules = RULES[m.game];

  const headline =
    winSeat !== null
      ? `${short(m.sides[winSeat]!.player)} won`
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
    const mark = scores ? String(scores[i]) : m.game === "holdem" && winSeat !== null ? (winSeat === i ? "Won" : "Lost") : null;
    return (
      <div key={i}>
        {s ? (
          <>
            <Image className="mr-sp-av" src={avatarFor(s.player)} alt="" width={56} height={56} />
            <span className="mono">{short(s.player)}</span>
            {s.funder !== s.player && <small className="note">Backed by {short(s.funder)}</small>}
          </>
        ) : (
          <span>No opponent yet</span>
        )}
        {mark && <b className={`tnum${winSeat !== null && winSeat !== i ? " dim" : ""}`}>{mark}</b>}
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

          <p className="mr-copy">
            {m.status === "open" || m.status === "active"
              ? "You are watching a Match you are not part of. Runs and cards stay hidden until it settles."
              : "You are viewing a Match you were not part of. The result is settled on Solana devnet."}
          </p>
        </div>
      </section>

      <div className="mr-actions">
        {onSignIn ? (
          <Button variant="money" size="lg" onClick={onSignIn}>Sign in to play</Button>
        ) : (
          <Button variant="money" size="lg" href={`/play/queue?${m.game === "holdem" ? "game=holdem&" : ""}entry=${m.entry}`}>
            Play {GAME_NAMES[m.game]}
          </Button>
        )}
        <Button size="lg" href="/">Lobby</Button>
        <Button size="lg" href="/matches">All Matches</Button>
      </div>
    </div>
  );
}
