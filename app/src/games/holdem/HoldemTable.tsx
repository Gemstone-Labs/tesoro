"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useGuideHidden } from "@/components/guide/Guide";
import { fmtGemas } from "@/lib/format";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, STATUS, tesoroAccountPda, type Action, type Table } from "./chain";
import { EMPTY_LOG, stepHandLog, type HandLog, type LogStreet } from "./handlog";
import { FlipCard, PlayingCard, type FlipState } from "./cards";
import { centre, flyFrom } from "./motion";
import { inPlay } from "./rules";
import { ActionBar } from "./ActionBar";
import { ChipStack } from "./ChipStack";
import { Seat } from "./Seat";
import { bestHand } from "./reading";
import { useTableFeed } from "./useTableFeed";
import { Arena, Callout, MuteToggle, prefersReducedMotion, sfx } from "../fx";
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
  const myHand = myCards && (playing || showLast) && !(feed.dealing && playing) ? bestHand(myCards, board).name : null;

  const level = `${chips(t.smallBlind)} / ${chips(t.bigBlind)}`;
  const sbSeat = t.dealer;
  const ringFraction = practice ? 1 : Math.min(1, Math.max(0, remaining / total));
  const ringLow = !practice && remaining <= 10;
  const bots = art.avatars;

  // Where things are on screen, so cards leave the deck, chips sweep into the pot and the dealer button slides.
  const deckRef = useRef<HTMLDivElement>(null);
  const potRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const betSpots = useRef<[{ amount: bigint; at: { x: number; y: number } } | null, { amount: bigint; at: { x: number; y: number } } | null]>([null, null]);
  const sweptBatch = useRef(0);
  const dealerAt = useRef<{ x: number; y: number } | null>(null);
  const [ghosts, setGhosts] = useState<{ id: number; seat: number; amount: bigint; x: number; y: number; dx: number; dy: number }[]>([]);
  const batch = feed.batch;

  useLayoutEffect(() => {
    // Chips that were in front of a seat before this read go to the pot (the bets are already gone from the DOM).
    const sweeps = batch?.events.some((e) => e.type === "sweep");
    const pot = potRef.current?.getBoundingClientRect();
    if (batch && batch.id !== sweptBatch.current && sweeps && pot && !prefersReducedMotion()) {
      sweptBatch.current = batch.id;
      const to = centre(pot);
      const made = ([0, 1] as const).flatMap((i) => {
        const b = betSpots.current[i];
        return b ? [{ id: batch.id * 2 + i, seat: i, amount: b.amount, x: b.at.x, y: b.at.y, dx: to.x - b.at.x, dy: to.y - b.at.y }] : [];
      });
      if (made.length) {
        setGhosts((g) => [...g, ...made]);
        const ids = made.map((m) => m.id);
        setTimeout(() => setGhosts((g) => g.filter((x) => !ids.includes(x.id))), 800);
      }
    }
    betSpots.current = [0, 1].map((i) => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-bet="${i}"]`);
      return el && t.bets[i] > 0n ? { amount: t.bets[i], at: centre(el.getBoundingClientRect()) } : null;
    }) as typeof betSpots.current;

    // The dealer button slides to the new dealer.
    const d = tableRef.current?.querySelector<HTMLElement>(".hd-btn");
    if (d) {
      const at = centre(d.getBoundingClientRect());
      if (dealerAt.current && Math.hypot(at.x - dealerAt.current.x, at.y - dealerAt.current.y) > 24) flyFrom(d, dealerAt.current, { duration: 600, spin: 180, scale: 1 });
      dealerAt.current = at;
    }
  }, [batch, t]);

  // Sound follows the same events as the motion.
  useEffect(() => {
    if (!batch) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, cue: Parameters<typeof sfx>[0]) => timers.push(setTimeout(() => sfx(cue), ms));
    for (const e of batch.events) {
      if (e.type === "action") at(0, e.kind === "check" ? "check" : e.kind === "fold" ? "fold" : "chip");
      else if (e.type === "sweep") at(120, "chip");
      else if (e.type === "deal") {
        [0, 110, 220, 330].forEach((ms) => at(ms, "deal"));
        at(1000, "flip");
      } else if (e.type === "street") {
        e.cards.forEach((_, k) => {
          at(350 + k * 140, "deal");
          at(350 + k * 140 + 440, "flip");
        });
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [batch]);

  const fresh = batch?.events ?? [];
  const dealtNow = fresh.some((e) => e.type === "deal");
  const holeFly = (order: number) => (dealtNow ? { deck: deckRef, delay: order * 110 } : null);
  const streetCards = (() => {
    const s = fresh.find((e) => e.type === "street");
    // The board index the first dealt card of the latest street lands on, and how many land.
    if (!s || s.type !== "street") return null;
    return s.street === "flop" ? { from: 0, n: 3 } : s.street === "turn" ? { from: 3, n: 1 } : { from: 4, n: 1 };
  })();
  const boardFly = (i: number) => {
    if (!streetCards || i < streetCards.from || i >= streetCards.from + streetCards.n) return null;
    // After the chips sweep in, the cards leave the deck one by one.
    const k = i - streetCards.from;
    return { fly: { deck: deckRef, delay: 350 + k * 140 }, turn: 350 + k * 140 + 440 };
  };
  const dealingMine = feed.dealing && playing;
  const dealtHand = playing ? t.handNo : lh.handNo;
  const oppState: FlipState = oppCards ? "up" : playing ? "down" : "empty";

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
        <div className="hdx-table" ref={tableRef}>
          <div className="hdx-surface" aria-hidden="true">
            <div className="hdx-rim">
              <div className="hdx-bed" />
            </div>
          </div>
          <div className="hdx-deck" ref={deckRef} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
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
              index={opp}
            >
              {[0, 1].map((i) => (
                <FlipCard key={`o${dealtHand}-${i}`} card={oppCards?.[i]} state={oppState} fly={holeFly(i === 0 ? 0 : 2)} turnDelay={i * 120} />
              ))}
            </Seat>

            <div className="hdx-mid">
              <div ref={potRef} className="cut hdx-pot mono" aria-label={`Pot ${chips(t.pot)} Chips`}>
                <ChipStack amount={t.pot} piles={t.pot > 1500n ? 3 : t.pot > 400n ? 2 : 1} />
                <span className="hdx-pot-t">
                  <span className="hdx-pot-l">Pot</span>
                  <b>
                    <CountUp value={Number(t.pot)} format={chips} />
                  </b>
                </span>
              </div>
              <div className="hdx-board" aria-label="Board">
                {[0, 1, 2, 3, 4].map((i) => {
                  const f = boardFly(i);
                  const known = board[i] !== undefined && board[i] < 52;
                  return <FlipCard key={`b${t.handNo}-${i}`} card={board[i]} state={known ? "up" : "empty"} size="lg" fly={f?.fly} turnDelay={f?.turn ?? 0} />;
                })}
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
              index={seat}
              mine
            >
              {[0, 1].map((i) => (
                <FlipCard
                  key={`m${hole?.handNo ?? 0}-${i}`}
                  card={myCards?.[i]}
                  state={myCards ? (dealingMine ? "down" : "up") : playing ? "down" : "empty"}
                  size="lg"
                  fly={holeFly(i === 0 ? 1 : 3)}
                  turnDelay={i * 140}
                />
              ))}
            </Seat>
          </div>
          {feed.banner && (
            <div className="hdx-banner">
              <Callout key={feed.banner.id} text={feed.banner.text} duration={1100} className="hdx-banner-host" />
            </div>
          )}
          {feed.toast && (
            <div className="hdx-toast">
              <Callout key={feed.toast.id} text={feed.toast.text} tone="warn" duration={2400} className="hdx-toast-host" />
            </div>
          )}
        </div>
        {ghosts.map((g) => (
          <div key={g.id} className="hd-ghost" style={{ left: g.x, top: g.y, ["--dx" as string]: `${g.dx}px`, ["--dy" as string]: `${g.dy}px` }} aria-hidden="true">
            <ChipStack amount={g.amount} />
          </div>
        ))}
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
