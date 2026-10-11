"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { AccountLink } from "@/components/account/AccountLink";
import { Button, GemaMark } from "@/components/ui";
import { useGuideHidden } from "@/components/guide/Guide";
import { fmtGemas } from "@/lib/format";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, STATUS, call, check, fold, raise, tesoroAccountPda, type Action, type Table } from "./chain";
import { EMPTY_LOG, stepHandLog, type HandLog, type LogStreet } from "./handlog";
import { PlayingCard } from "./cards";
import { inPlay, legalMoves } from "./rules";
import { Arena, MuteToggle } from "../fx";
import "./holdem.css";
import { PlayerName } from "@/components/account/Player";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
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

/** The hand log, inferred by this client from table reads (handlog.ts). */
function useHandLog(t: Table, seat: 0 | 1): LogStreet[] {
  const [log, setLog] = useState<HandLog>(EMPTY_LOG);
  useEffect(() => {
    const timer = setTimeout(() => setLog((cur) => stepHandLog(cur, t, seat)), 0);
    return () => clearTimeout(timer);
  }, [t, seat]);
  return log.streets;
}

interface Props {
  table: Table;
  seat: 0 | 1;
  hole: { handNo: number; cards: [number, number] } | null;
  busy: string | null;
  /** The Match is over: no clock, no actions. */
  ended: boolean;
  /** The Gema entry of this Match, for the info panel. */
  entry?: number;
  onAct: (a: Action, label: string) => void;
  onClaim: () => void;
  /** Local practice against the bot: no turn clock, no addresses. */
  practice?: boolean;
}

/**
 * The Hold'em table for one Player (take-1: play-holdem): info panel left, the octagonal table in
 * the centre, the turn timer and hand log right, the action bar below. Chips are plain numbers in
 * mono: they are scorekeeping, not Gemas. No character anywhere.
 */
export function HoldemTable({ table: t, seat, hole, busy, ended, entry, onAct, onClaim, practice }: Props) {
  const opp = 1 - seat;
  const now = useNow();
  const [walletA, walletB] = t.players.map((p) => p.toBase58());
  // The table holds wallets; every other screen shows a Player by their Account key.
  const accounts = useMemo(
    () => (practice ? [] : [walletA, walletB].map((w) => tesoroAccountPda(new PublicKey(w)).toBase58())),
    [practice, walletA, walletB],
  );
  const playing = inPlay(t);
  const myTurn = playing && t.toAct === seat;
  const between = !ended && t.status === STATUS.live && t.phase === PHASE.shuffle;
  const lh = t.lastHand;
  const showLast = (between || ended || t.phase === PHASE.none) && lh.handNo > 0;
  const remaining = Math.ceil(t.deadline - now / 1000);
  const total = t.phase === PHASE.shuffle ? 60 : 30;
  const expired = !practice && !ended && t.status === STATUS.live && remaining < -1;
  const log = useHandLog(t, seat);
  useGuideHidden(!ended);

  const board = playing ? t.board : showLast ? lh.board : t.board;
  const shownMine = showLast && lh.showdown && lh.shown[seat][0] !== NO_CARD ? lh.shown[seat] : null;
  const myCards = hole && (playing ? hole.handNo === t.handNo : hole.handNo === lh.handNo) ? hole.cards : playing ? null : shownMine;
  const oppCards: [number, number] | null = playing
    ? null
    : showLast && lh.showdown && lh.shown[opp][0] !== NO_CARD
      ? lh.shown[opp]
      : null;
  const oppBacks = playing;

  const level = `${chips(t.smallBlind)} / ${chips(t.bigBlind)}`;
  const sbSeat = t.dealer;

  return (
    <Arena game="holdem">
    <section className="hdx" aria-label="Hold'em table">
      <header className="hdx-head" aria-label="Table">
        <div className="hdx-head-l">
          <h1 className="hdx-title">Heads-up Hold&apos;em</h1>
          <p className="mono hdx-level" aria-label={`Blinds ${level}`}>
            Blinds {level.replace(" / ", "/")} · Hand #{t.handNo}
          </p>
          {entry !== undefined && (
            <span className="cut cut-btn hdx-entry">
              <GemaMark size={18} /> {fmtGemas(entry)} entry
            </span>
          )}
          <MuteToggle />
        </div>
        {!ended && t.status === STATUS.live && (
          <div className="hdx-clock" role="timer" aria-live="off">
            <div className="hdx-clock-top">
              <span className="hdx-who">
                {t.phase === PHASE.shuffle ? `Dealing hand ${t.handNo}` : myTurn ? "Your turn" : "Opponent's turn"}
                {playing ? ` · ${STREET[t.phase]}` : ""}
              </span>
              {!practice && (
                <span className={`mono hdx-secs${remaining <= 10 ? " low" : ""}`}>{remaining >= 60 ? clock(remaining) : `${Math.max(0, remaining)} s`}</span>
              )}
            </div>
            {!practice && (
              <div className="hd-clock-bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, Math.max(0, (remaining / total) * 100))}%` }} className={remaining <= 10 ? "low" : ""} />
              </div>
            )}
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
      </header>

      <div className="hdx-stage">
        <div className="hdx-table">
          <div className="hdx-felt">
            <Seat
              who="Opponent"
              address={practice ? "Bot" : undefined}
              account={practice ? undefined : accounts[opp]}
              linked={ended}
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

            <div className="hdx-mid">
              <div className="cut hdx-pot mono" aria-label={`Pot ${chips(t.pot)} Chips`}>
                Pot <b>{chips(t.pot)}</b> Chips
              </div>
              <div className="hdx-board" aria-label="Board">
                {[0, 1, 2, 3, 4].map((i) => (
                  <PlayingCard key={i} card={board[i]} size="lg" />
                ))}
              </div>
            </div>

            <Seat
              who="You"
              account={practice ? undefined : accounts[seat]}
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
        </div>
        {showLast && <HandResult t={t} seat={seat} ended={ended} />}
        {!showLast && playing && lh.handNo > 0 && lh.result !== NO_WINNER && (
          <p className="meta hd-last">
            Hand {lh.handNo}: {lh.result === SPLIT ? "split pot" : lh.result === seat ? "you won" : "you lost"} · {chips(lh.pot)} Chips
            {lh.showdown ? " at showdown" : lh.result === seat ? " (opponent folded)" : " (you folded)"}
          </p>
        )}
      </div>

      {!ended && (
        <ActionBar key={`${t.handNo}-${t.phase}`} table={t} seat={seat} enabled={myTurn && busy === null} busy={busy} onAct={onAct} />
      )}
      <details className="hdx-log">
        <summary>Hand log · inferred</summary>
        <div className="hdx-log-body">
          {log.length === 0 && <p className="meta">The hand log fills as the hand is played.</p>}
          {log.map((s, i) => (
            <div key={`${s.name}-${i}`} className="hdx-street">
              <b>{s.name}</b>
              {s.rows.length === 0 && (
                <div className="hdx-row">
                  <span>—</span>
                  <span />
                </div>
              )}
              {s.rows.map((r, j) => (
                <div key={j} className="hdx-row">
                  <span>{r.who}</span>
                  <span className="mono">{r.text}</span>
                </div>
              ))}
            </div>
          ))}
          <p className="note">Inferred by this client from table reads, not a record from the table: a slow read can merge two actions into one.</p>
        </div>
      </details>

    </section>
    </Arena>
  );
}

function Seat({
  who,
  address,
  account,
  linked,
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
  /** A plain label in place of a Player (the practice bot). */
  address?: string;
  /** The Player's Account key, as shown everywhere else (the table itself holds wallets). */
  account?: string;
  /** Link the key to the Account: only once the Match has ended, never during a hand. */
  linked?: boolean;
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
    <div className={`hdx-seat${mine ? " mine" : ""}${active ? " active" : ""}`}>
      <div className="hd-cards">{children}</div>
      <div className="cut hdx-plaque">
        <div className="hd-name">
          <strong>{who}</strong>
          {dealer && <span className="hd-btn" title="Button, posts the small blind" aria-label="Dealer button">D</span>}
          {active && <span className="hd-turn">To act</span>}
          <span className="mono hd-addr">{account ? linked ? <AccountLink account={account} newTab /> : <PlayerName account={account} /> : address}</span>
        </div>
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

/** Fold / Check / Call / Raise, then Raise to with a slider, presets and All-in (take-1: bottom action bar). */
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
  const min = Number(lg.minTo);
  const max = Number(lg.maxTo);
  const [to, setTo] = useState<number>(min);
  const value = Math.min(max, Math.max(min, Number.isFinite(to) ? to : min));
  const facing = lg.toCall > 0n;
  const pot = Number(t.pot);
  const current = Number(t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
  const raiseOk = enabled && lg.canRaise;
  const verb = lg.isBet ? "Bet" : "Raise";
  const preset = (label: string, target: number) => (
    <button key={label} type="button" className="cut cut-chip hd-preset" disabled={!raiseOk} onClick={() => setTo(Math.min(max, Math.max(min, Math.round(target))))}>
      {label === "All-in" ? "All-in" : label}
    </button>
  );

  return (
    <div className="cut cut-frame hdx-actions" role="group" aria-label="Actions">
      <div className="hdx-btns">
        <button type="button" className="cut cut-btn hdx-btn" disabled={!enabled} onClick={() => onAct(fold(), "fold")}>
          Fold
        </button>
        <button type="button" className={`cut cut-btn hdx-btn${enabled && !facing ? " primary" : ""}`} disabled={!enabled || facing} onClick={() => onAct(check(), "check")}>
          Check
        </button>
        <button type="button" className={`cut cut-btn hdx-btn${enabled && facing ? " primary" : ""}`} disabled={!enabled || !facing} onClick={() => onAct(call(), `call ${lg.toCall}`)}>
          <span>Call</span>
          {facing && <small className="mono">{chips(lg.toCall)}</small>}
        </button>
        <button type="button" className="cut cut-btn hdx-btn" disabled={!raiseOk} onClick={() => onAct(raise(value), `${verb.toLowerCase()} to ${value}`)}>
          {verb}
        </button>
      </div>
      <div className="hdx-raise">
        <div className="hdx-raise-in">
          <label className="label" htmlFor="hd-to">
            {verb} to
          </label>
          <input
            id="hd-to"
            className="tnum mono"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value}
            disabled={!raiseOk}
            onChange={(e) => setTo(Number(e.target.value))}
          />
        </div>
        <div className="hdx-raise-ctl">
          <input
            className="hd-range"
            type="range"
            aria-label={`${verb} to`}
            min={min}
            max={max}
            step={1}
            value={value}
            disabled={!raiseOk || min === max}
            style={{ ["--pct" as string]: max === min ? "100%" : `${((value - min) / (max - min)) * 100}%` }}
            onChange={(e) => setTo(Number(e.target.value))}
          />
          <div className="hd-presets">
            {preset("Min", min)}
            {preset("½ pot", current + pot / 2)}
            {preset("Pot", current + pot)}
            {preset("All-in", max)}
          </div>
        </div>
      </div>
      {!enabled && busy === null && <span className="hd-hint meta">Actions unlock on your turn.</span>}
      {busy && busy !== "claim_timeout" && <span className="hd-hint meta">Sending {busy.split(" ")[0]}…</span>}
    </div>
  );
}
