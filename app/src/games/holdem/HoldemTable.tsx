"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, SPEED_TURBO, STATUS, call, check, fold, raise, type Action, type Table } from "./chain";
import { PlayingCard } from "./cards";
import { inPlay, legalMoves } from "./rules";
import "./holdem.css";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const short = (k: { toBase58(): string }) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const STREET = ["Shuffling", "Preflop", "Flop", "Turn", "River", ""];

function useNow(ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

const clock = (secs: number) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.max(0, secs) % 60).padStart(2, "0")}`;

interface Props {
  table: Table;
  seat: 0 | 1;
  hole: { handNo: number; cards: [number, number] } | null;
  busy: string | null;
  /** The Match is over: no clock, no actions. */
  ended: boolean;
  onAct: (a: Action, label: string) => void;
  onClaim: () => void;
}

/**
 * The Hold'em table for one Player: opponent on top, board and pot in the middle, your cards below,
 * then the clock and the action bar. Chips are plain numbers in mono: they are scorekeeping, not Gemas.
 */
export function HoldemTable({ table: t, seat, hole, busy, ended, onAct, onClaim }: Props) {
  const opp = 1 - seat;
  const now = useNow();
  const playing = inPlay(t);
  const myTurn = playing && t.toAct === seat;
  const between = !ended && t.status === STATUS.live && t.phase === PHASE.shuffle;
  const lh = t.lastHand;
  const showLast = (between || ended || t.phase === PHASE.none) && lh.handNo > 0;
  const remaining = Math.ceil(t.deadline - now / 1000);
  const total = t.phase === PHASE.shuffle ? 60 : 30;
  const expired = !ended && t.status === STATUS.live && remaining < -1;

  const board = playing ? t.board : showLast ? lh.board : t.board;
  const myCards = hole && (playing ? hole.handNo === t.handNo : hole.handNo === lh.handNo) ? hole.cards : null;
  const oppCards: [number, number] | null = playing
    ? null
    : showLast && lh.showdown && lh.shown[opp][0] !== NO_CARD
      ? lh.shown[opp]
      : null;
  const oppBacks = playing;

  const level = `${chips(t.smallBlind)}/${chips(t.bigBlind)}`;
  const sbSeat = t.dealer;

  return (
    <section className="hd" aria-label="Hold'em table">
      <div className="hd-bar">
        <span className="mono hd-level" aria-label={`Blinds ${level}`}>
          Blinds {level}
        </span>
        <span className="mono hd-hand">
          Hand {t.handNo}
          {t.speed === SPEED_TURBO ? " · Turbo" : ""}
        </span>
      </div>

      <div className="cut cut-frame hd-table">
        <Seat
          who="Opponent"
          address={short(t.players[opp])}
          stack={t.stacks[opp]}
          bet={t.bets[opp]}
          dealer={sbSeat === opp}
          active={playing && t.toAct === opp}
          allIn={playing && t.stacks[opp] === 0n}
          missed={t.missed[opp]}
        >
          {oppCards ? (
            <>
              <PlayingCard card={oppCards[0]} />
              <PlayingCard card={oppCards[1]} />
            </>
          ) : (
            <>
              <PlayingCard back={oppBacks} />
              <PlayingCard back={oppBacks} />
            </>
          )}
        </Seat>

        <div className="hd-mid">
          <div className="hd-board" aria-label="Board">
            {[0, 1, 2, 3, 4].map((i) => (
              <PlayingCard key={i} card={board[i]} />
            ))}
          </div>
          <div className="hd-pot mono" aria-label={`Pot ${chips(t.pot)} Chips`}>
            <span className="hd-pot-l">Pot</span> {chips(t.pot)}
            <span className="hd-pot-u"> Chips</span>
          </div>
        </div>

        <Seat
          who="You"
          address={short(t.players[seat])}
          stack={t.stacks[seat]}
          bet={t.bets[seat]}
          dealer={sbSeat === seat}
          active={myTurn}
          allIn={playing && t.stacks[seat] === 0n}
          missed={t.missed[seat]}
          mine
        >
          <PlayingCard card={myCards?.[0]} size="lg" />
          <PlayingCard card={myCards?.[1]} size="lg" />
        </Seat>
      </div>

      {showLast && <HandResult t={t} seat={seat} ended={ended} />}
      {!showLast && playing && lh.handNo > 0 && lh.result !== NO_WINNER && (
        <p className="meta hd-last">
          Hand {lh.handNo}: {lh.result === SPLIT ? "split pot" : lh.result === seat ? "you won" : "you lost"} · {chips(lh.pot)} Chips
          {lh.showdown ? " at showdown" : lh.result === seat ? " (opponent folded)" : " (you folded)"}
        </p>
      )}

      {!ended && t.status === STATUS.live && (
        <div className="hd-clock" role="timer" aria-live="off">
          <div className="hd-clock-top">
            <span className="hd-who">
              {t.phase === PHASE.shuffle ? "Dealing hand " + t.handNo : myTurn ? "Your turn" : "Opponent's turn"}
              {playing ? ` · ${STREET[t.phase]}` : ""}
            </span>
            <span className={`mono hd-secs${remaining <= 10 ? " low" : ""}`}>{clock(remaining)}</span>
          </div>
          <div className="hd-clock-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(0, (remaining / total) * 100))}%` }} className={remaining <= 10 ? "low" : ""} />
          </div>
          {expired && !myTurn && (
            <div className="hd-claim">
              <span className="meta">{t.phase === PHASE.shuffle ? "Someone has not dealt in time." : "Your opponent's clock ran out."}</span>
              <Button size="sm" onClick={onClaim} disabled={busy !== null}>
                {busy === "claim_timeout" ? "Claiming…" : "Claim timeout"}
              </Button>
            </div>
          )}
          {expired && myTurn && <span className="meta">Your clock ran out: act now, or your opponent can claim a timeout.</span>}
        </div>
      )}

      {!ended && (
        <ActionBar
          key={`${t.handNo}-${t.phase}`}
          table={t}
          seat={seat}
          enabled={myTurn && busy === null}
          busy={busy}
          onAct={onAct}
        />
      )}
    </section>
  );
}

function Seat({
  who,
  address,
  stack,
  bet,
  dealer,
  active,
  allIn,
  missed,
  mine,
  children,
}: {
  who: string;
  address: string;
  stack: bigint;
  bet: bigint;
  dealer: boolean;
  active: boolean;
  allIn: boolean;
  missed: number;
  mine?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`hd-seat${mine ? " mine" : ""}${active ? " active" : ""}`}>
      <div className="hd-cards">{children}</div>
      <div className="hd-info">
        <div className="hd-name">
          <strong>{who}</strong>
          {dealer && <span className="hd-btn" title="Button, posts the small blind" aria-label="Dealer button">D</span>}
          {active && <span className="hd-turn">To act</span>}
        </div>
        <span className="mono hd-addr">{address}</span>
        <div className="hd-stack mono" aria-label={`${who} stack ${chips(stack)} Chips`}>
          {chips(stack)} <span className="hd-unit">Chips</span>
          {allIn && <span className="hd-tag">All-in</span>}
        </div>
        {missed > 0 && <span className="meta hd-missed">Missed {missed} of 3 turns</span>}
      </div>
      <div className="hd-bet mono" aria-label={bet > 0n ? `Bet ${chips(bet)}` : undefined}>
        {bet > 0n ? chips(bet) : ""}
      </div>
    </div>
  );
}

function HandResult({ t, seat, ended }: { t: Table; seat: number; ended: boolean }) {
  const lh = t.lastHand;
  if (lh.result === NO_WINNER) return null;
  const split = lh.result === SPLIT;
  const won = lh.result === seat;
  const title = split ? "Split pot" : won ? "You won the hand" : "You lost the hand";
  const how = split
    ? "Both hands are equal."
    : lh.showdown
      ? "Showdown: both hands are shown."
      : won
        ? "Your opponent folded."
        : "You folded.";
  return (
    <div className="hd-result" role="status">
      <div className="hd-result-top">
        <strong>
          {ended ? "Final hand · " : `Hand ${lh.handNo} · `}
          {title}
        </strong>
        <span className="mono">{chips(lh.pot)} Chips</span>
      </div>
      <span className="meta">{how}</span>
      {lh.showdown && (
        <div className="hd-show" aria-label="Shown cards">
          <span className="hd-show-l">You</span>
          <PlayingCard card={lh.shown[seat][0]} />
          <PlayingCard card={lh.shown[seat][1]} />
          <span className="hd-show-l">Opponent</span>
          <PlayingCard card={lh.shown[1 - seat][0]} />
          <PlayingCard card={lh.shown[1 - seat][1]} />
        </div>
      )}
    </div>
  );
}

function ActionBar({
  table: t,
  seat,
  enabled,
  busy,
  onAct,
}: {
  table: Table;
  seat: number;
  enabled: boolean;
  busy: string | null;
  onAct: (a: Action, label: string) => void;
}) {
  const lg = legalMoves(t, seat);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<number>(Number(lg.minTo));
  const min = Number(lg.minTo);
  const max = Number(lg.maxTo);
  const value = Math.min(max, Math.max(min, to));
  const facing = lg.toCall > 0n;
  const pot = Number(t.pot);
  const current = Number(t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
  const preset = (label: string, target: number) => (
    <button key={label} type="button" className="cut cut-chip hd-preset" onClick={() => setTo(Math.min(max, Math.max(min, Math.round(target))))}>
      {label}
    </button>
  );

  if (!open) {
    return (
      <div className="hd-actions" role="group" aria-label="Actions">
        <Button disabled={!enabled} onClick={() => onAct(fold(), "fold")}>
          Fold
        </Button>
        {facing ? (
          <Button disabled={!enabled} onClick={() => onAct(call(), `call ${lg.toCall}`)}>
            Call {chips(lg.toCall)}
          </Button>
        ) : (
          <Button disabled={!enabled} onClick={() => onAct(check(), "check")}>
            Check
          </Button>
        )}
        <Button
          disabled={!enabled || !lg.canRaise}
          onClick={() => {
            setTo(min);
            setOpen(true);
          }}
        >
          {lg.isBet ? "Bet" : "Raise"}…
        </Button>
        <Button disabled={!enabled || (!lg.canRaise && !facing)} onClick={() => onAct(lg.canRaise ? raise(lg.maxTo) : call(), lg.canRaise ? "all-in" : "call all-in")}>
          All-in {chips(lg.maxTo - t.bets[seat])}
        </Button>
        {!enabled && busy === null && <span className="hd-hint meta">Actions unlock on your turn.</span>}
        {busy && busy !== "claim_timeout" && <span className="hd-hint meta">Sending {busy.split(" ")[0]}…</span>}
      </div>
    );
  }

  return (
    <div className="hd-raise" role="group" aria-label={lg.isBet ? "Bet" : "Raise"}>
      <div className="hd-raise-head">
        <label className="label" htmlFor="hd-to">
          {lg.isBet ? "Bet to" : "Raise to"}
        </label>
        <span className="mono hd-raise-v">{chips(value)}</span>
      </div>
      <input
        id="hd-to"
        className="hd-range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={min === max}
        style={{ ["--pct" as string]: max === min ? "100%" : `${((value - min) / (max - min)) * 100}%` }}
        onChange={(e) => setTo(Number(e.target.value))}
      />
      <div className="hd-raise-ticks mono" aria-hidden="true">
        <span>Min {chips(min)}</span>
        <span>All-in {chips(max)}</span>
      </div>
      <div className="hd-presets">
        {preset("Min", min)}
        {preset("½ pot", current + pot / 2)}
        {preset("Pot", current + pot)}
        {preset("All-in", max)}
      </div>
      <div className="hd-actions two">
        <Button onClick={() => setOpen(false)}>Back</Button>
        <Button
          disabled={!enabled}
          onClick={() => onAct(raise(value), `${lg.isBet ? "bet" : "raise"} to ${value}`)}
        >
          {lg.isBet ? "Bet" : "Raise"} to {chips(value)}
        </Button>
      </div>
      <span className="meta">
        Min raise {chips(lg.minTo)} · blinds {chips(t.smallBlind)}/{chips(t.bigBlind)}
      </span>
    </div>
  );
}
