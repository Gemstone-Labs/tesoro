"use client";

import { useEffect, useRef, useState } from "react";
import { Button, GemaMark } from "@/components/ui";
import { useGuideHidden } from "@/components/guide/Guide";
import { fmtGemas } from "@/lib/format";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, SPEED_TURBO, STATUS, call, check, fold, raise, type Action, type Table } from "./chain";
import { PlayingCard } from "./cards";
import { inPlay, legalMoves } from "./rules";
import "./holdem.css";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const short = (k: { toBase58(): string }) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const STREET = ["Shuffling", "Preflop", "Flop", "Turn", "River", ""];
const STREET_LOG = ["", "Pre-flop", "Flop", "Turn", "River", ""];

function useNow(ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

const clock = (secs: number) => `${Math.floor(Math.max(0, secs) / 60)}:${String(Math.max(0, secs) % 60).padStart(2, "0")}`;

interface LogRow {
  who: string;
  text: string;
}
interface LogStreet {
  name: string;
  rows: LogRow[];
}
interface HandLog {
  hand: number;
  done: boolean;
  streets: LogStreet[];
}

/**
 * The hand log, as this client saw it. The table only publishes its current state, so actions are
 * inferred from how bets and stacks moved between two reads (a poll can merge two actions).
 */
function useHandLog(t: Table, seat: 0 | 1): LogStreet[] {
  const [log, setLog] = useState<HandLog>({ hand: 0, done: false, streets: [] });
  const prev = useRef<{ hand: number; phase: number; bets: [bigint, bigint]; stacks: [bigint, bigint] } | null>(null);
  const { handNo, phase, dealer, smallBlind, bigBlind, lastHand } = t;
  const b0 = t.bets[0];
  const b1 = t.bets[1];
  const s0 = t.stacks[0];
  const s1 = t.stacks[1];

  useEffect(() => {
    const timer = setTimeout(() => {
      const who = (i: number) => (i === seat ? "You" : "Opponent");
      const live = phase >= PHASE.preflop && phase <= PHASE.river;
      const p = prev.current;
      prev.current = { hand: handNo, phase, bets: [b0, b1], stacks: [s0, s1] };
      setLog((cur) => {
        let L: HandLog = { hand: cur.hand, done: cur.done, streets: cur.streets.map((s) => ({ ...s, rows: [...s.rows] })) };
        // The hand that just ended: record how.
        if (!L.done && L.hand > 0 && lastHand.handNo === L.hand && lastHand.result !== NO_WINNER) {
          const last = L.streets[L.streets.length - 1];
          if (last) {
            if (lastHand.showdown) last.rows.push({ who: "Both", text: "Showdown" });
            else if (lastHand.result !== SPLIT) last.rows.push({ who: who(1 - lastHand.result), text: "Fold" });
          }
          L.done = true;
        }
        if (!live) return L;
        if (L.hand !== handNo) {
          L = { hand: handNo, done: false, streets: [{ name: STREET_LOG[phase], rows: [] }] };
          if (phase === PHASE.preflop) {
            L.streets[0].rows.push({ who: who(dealer), text: `Small blind ${chips(smallBlind)}` }, { who: who(1 - dealer), text: `Big blind ${chips(bigBlind)}` });
          }
          return L;
        }
        if (!p || p.hand !== handNo) return L;
        const cur0 = L.streets[L.streets.length - 1];
        const maxPrev = p.bets[0] > p.bets[1] ? p.bets[0] : p.bets[1];
        if (p.phase !== phase) {
          // The street closed between two reads: whoever put chips in called; nobody else acted, so they checked.
          for (const i of [0, 1] as const) {
            const put = p.stacks[i] - [s0, s1][i];
            if (put > 0n && p.bets[i] < maxPrev) cur0.rows.push({ who: who(i), text: `Call ${chips(maxPrev - p.bets[i] < put ? maxPrev - p.bets[i] : put)}` });
            else if (p.phase >= PHASE.flop && !cur0.rows.some((r) => r.who === who(i))) cur0.rows.push({ who: who(i), text: "Check" });
          }
          L.streets.push({ name: STREET_LOG[phase], rows: [] });
          return L;
        }
        for (const i of [0, 1] as const) {
          const nb = [b0, b1][i];
          if (nb <= p.bets[i]) continue;
          const allIn = [s0, s1][i] === 0n;
          const text = nb <= maxPrev ? `Call ${chips(nb)}` : maxPrev === 0n ? `Bet ${chips(nb)}` : `Raise to ${chips(nb)}`;
          cur0.rows.push({ who: who(i), text: allIn ? `${text} · all-in` : text });
        }
        return L;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [handNo, phase, dealer, smallBlind, bigBlind, lastHand, b0, b1, s0, s1, seat]);

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
}

/**
 * The Hold'em table for one Player (take-1: play-holdem): info panel left, the octagonal table in
 * the centre, the turn timer and hand log right, the action bar below. Chips are plain numbers in
 * mono: they are scorekeeping, not Gemas. No character anywhere.
 */
export function HoldemTable({ table: t, seat, hole, busy, ended, entry, onAct, onClaim }: Props) {
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
  const turbo = t.speed === SPEED_TURBO;

  return (
    <section className="hdx" aria-label="Hold'em table">
      <aside className="cut cut-frame hdx-panel hdx-info" aria-label="Table">
        <h1 className="h-section">Heads-up Hold&apos;em</h1>
        <p className="mono hdx-level">
          {level.replace(" / ", "/")} · {turbo ? "Turbo" : "Standard"}
        </p>
        {entry !== undefined && (
          <span className="cut cut-btn hdx-entry">
            <GemaMark size={22} /> {fmtGemas(entry)} entry
          </span>
        )}
        <dl className="hdx-kv">
          <div>
            <dt>Hand</dt>
            <dd className="mono">#{t.handNo}</dd>
          </div>
          <div>
            <dt>Blinds</dt>
            <dd className="mono" aria-label={`Blinds ${level}`}>{level}</dd>
          </div>
          <div>
            <dt>Players</dt>
            <dd className="mono">2</dd>
          </div>
          <div>
            <dt>Table</dt>
            <dd className="mono">{turbo ? "Turbo" : "Standard"}</dd>
          </div>
        </dl>
      </aside>

      <div className="hdx-stage">
        <div className="hdx-table">
          <div className="hdx-felt">
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

            <div className="hdx-mid">
              <div className="hdx-pot mono" aria-label={`Pot ${chips(t.pot)} Chips`}>
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
        </div>
        {showLast && <HandResult t={t} seat={seat} ended={ended} />}
        {!showLast && playing && lh.handNo > 0 && lh.result !== NO_WINNER && (
          <p className="meta hd-last">
            Hand {lh.handNo}: {lh.result === SPLIT ? "split pot" : lh.result === seat ? "you won" : "you lost"} · {chips(lh.pot)} Chips
            {lh.showdown ? " at showdown" : lh.result === seat ? " (opponent folded)" : " (you folded)"}
          </p>
        )}
      </div>

      <aside className="hdx-side" aria-label="Turn and hand log">
        {!ended && t.status === STATUS.live && (
          <div className="cut cut-frame hdx-panel hdx-clock" role="timer" aria-live="off">
            <div className="hdx-clock-top">
              <span className="hdx-who">
                {t.phase === PHASE.shuffle ? `Dealing hand ${t.handNo}` : myTurn ? "Your turn" : "Opponent's turn"}
                {playing ? ` · ${STREET[t.phase]}` : ""}
              </span>
              <span className={`mono hdx-secs${remaining <= 10 ? " low" : ""}`}>{remaining >= 60 ? clock(remaining) : `${Math.max(0, remaining)} s`}</span>
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

        <div className="cut cut-frame hdx-panel hdx-log">
          <h2 className="h-section">Hand log</h2>
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
          <p className="note">As seen from this table.</p>
        </div>
      </aside>

      {!ended && (
        <ActionBar key={`${t.handNo}-${t.phase}`} table={t} seat={seat} enabled={myTurn && busy === null} busy={busy} onAct={onAct} />
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
    <div className={`hdx-seat${mine ? " mine" : ""}${active ? " active" : ""}`}>
      <div className="hd-cards">{children}</div>
      <div className="cut hdx-plaque">
        <div className="hd-name">
          <strong>{who}</strong>
          {dealer && <span className="hd-btn" title="Button, posts the small blind" aria-label="Dealer button">D</span>}
          {active && <span className="hd-turn">To act</span>}
          <span className="mono hd-addr">{address}</span>
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
