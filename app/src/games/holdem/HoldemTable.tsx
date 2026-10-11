"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useGuideHidden } from "@/components/guide/Guide";
import { fmtGemas } from "@/lib/format";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, STATUS, tesoroAccountPda, type Action, type Table } from "./chain";
import { EMPTY_LOG, stepHandLog, type HandLog, type LogStreet } from "./handlog";
import { PlayingCard } from "./cards";
import { inPlay } from "./rules";
import { ActionBar } from "./ActionBar";
import { ChipStack } from "./ChipStack";
import { Seat } from "./Seat";
import { bestHand } from "./reading";
import { useTableFeed } from "./useTableFeed";
import { Arena, Callout, MuteToggle } from "../fx";
import { art } from "@/lib/art";
import "./holdem.css";

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

/** Your Chips against theirs across the Match, as a bar that leans to whoever has more. */
function ShareBar({ mine, theirs }: { mine: bigint; theirs: bigint }) {
  const total = Number(mine + theirs) || 1;
  const pct = Math.round((Number(mine) / total) * 100);
  return (
    <div className="hdx-share" role="img" aria-label={`Chips: you ${chips(mine)}, opponent ${chips(theirs)}`}>
      <span className="mono hdx-share-n">
        You <b>{chips(mine)}</b>
      </span>
      <span className="hdx-share-bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="mono hdx-share-n">
        <b>{chips(theirs)}</b> Opponent
      </span>
    </div>
  );
}

/**
 * The Hold'em table for one Player: the octagonal table in the centre with both seats, the pot and
 * the board, a share bar and turn timer in the header, the action bar below. Chips are neutral steel
 * discs and mono numbers: they are scorekeeping, not Gemas. No character anywhere.
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
  const feed = useTableFeed(t, seat);
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
  const myHand = myCards && (playing || showLast) ? bestHand(myCards, board).name : null;

  const level = `${chips(t.smallBlind)} / ${chips(t.bigBlind)}`;
  const sbSeat = t.dealer;
  const ringFraction = practice ? 1 : Math.min(1, Math.max(0, remaining / total));
  const ringLow = !practice && remaining <= 10;
  const bots = art.avatars;

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
        <ShareBar mine={t.stacks[seat] + t.committed[seat]} theirs={t.stacks[opp] + t.committed[opp]} />
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
              picture={practice ? bots[6] : undefined}
              linked={ended}
              stack={t.stacks[opp]}
              bet={t.bets[opp]}
              dealer={sbSeat === opp}
              active={playing && t.toAct === opp}
              fraction={ringFraction}
              low={ringLow}
              allIn={playing && t.stacks[opp] === 0n}
              missed={t.missed[opp]}
              say={feed.say[opp]}
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
                <ChipStack amount={t.pot} piles={t.pot > 1500n ? 3 : t.pot > 400n ? 2 : 1} />
                <span className="hdx-pot-t">
                  <span className="hdx-pot-l">Pot</span>
                  <b>
                    <CountUp value={Number(t.pot)} format={chips} />
                  </b>
                </span>
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
              picture={practice ? bots[2] : undefined}
              stack={t.stacks[seat]}
              bet={t.bets[seat]}
              dealer={sbSeat === seat}
              active={myTurn}
              fraction={ringFraction}
              low={ringLow}
              allIn={playing && t.stacks[seat] === 0n}
              missed={t.missed[seat]}
              say={feed.say[seat]}
              label={myHand}
              mine
            >
              <PlayingCard card={myCards?.[0]} size="lg" />
              <PlayingCard card={myCards?.[1]} size="lg" />
            </Seat>
          </div>
          {feed.toast && (
            <div className="hdx-toast">
              <Callout key={feed.toast.id} text={feed.toast.text} tone="warn" duration={2400} className="hdx-toast-host" />
            </div>
          )}
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
