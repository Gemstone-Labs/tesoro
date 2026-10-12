"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useGuideHidden } from "@/components/guide/Guide";
import { fmtGemas } from "@/lib/format";
import { NO_CARD, NO_WINNER, PHASE, SPLIT, STATUS, tesoroAccountPda, type Action, type Table } from "./chain";
import { EMPTY_LOG, stepHandLog, type HandLog, type LogStreet } from "./handlog";
import { FlipCard, type FlipState } from "./cards";
import { centre, flyFrom } from "./motion";
import { inPlay } from "./rules";
import { ActionBar } from "./ActionBar";
import { ChipStack } from "./ChipStack";
import { Seat } from "./Seat";
import { bestHand, resultSummary } from "./reading";
import { FOLD_CHIPS_AT, SHOWDOWN_CHIPS_AT, STREET_MS, runoutOffset, useTableFeed } from "./useTableFeed";
import { Handshake, Trophy, Flag } from "lucide-react";
import { Arena, Callout, FullScreenToggle, MuteToggle, prefersReducedMotion, sfx } from "../fx";
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
  /** Shown over the table a few seconds after the last hand (the practice Match result). */
  endPanel?: React.ReactNode;
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
export function HoldemTable({ table: t, seat, hole, busy, ended, entry, onAct, onClaim, practice, endPanel }: Props) {
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
  const feed = useTableFeed(t);
  useGuideHidden(!ended);

  const board = playing ? t.board : showLast ? lh.board : t.board;
  const shownMine = showLast && lh.showdown && lh.shown[seat][0] !== NO_CARD ? lh.shown[seat] : null;
  const myCards = hole && (playing ? hole.handNo === t.handNo : hole.handNo === lh.handNo) ? hole.cards : playing ? null : shownMine;
  const oppCards: [number, number] | null = playing
    ? null
    : showLast && lh.showdown && lh.shown[opp][0] !== NO_CARD
      ? lh.shown[opp]
      : null;

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
  const wonBatch = useRef(0);
  const dealerAt = useRef<{ seat: number; x: number; y: number } | null>(null);
  const [ghosts, setGhosts] = useState<{ id: number; amount: bigint; x: number; y: number; dx: number; dy: number; delay: number }[]>([]);
  const batch = feed.batch;

  // Spots are kept relative to the table, so scrolling or resizing between reads cannot leave them stale.
  const origin = () => {
    const r = tableRef.current?.getBoundingClientRect();
    return { x: r?.left ?? 0, y: r?.top ?? 0 };
  };

  useLayoutEffect(() => {
    // Chips that were in front of a seat before this read go to the pot (the bets are already gone from the DOM).
    const sweeps = batch?.events.some((e) => e.type === "sweep");
    const pot = potRef.current?.getBoundingClientRect();
    if (batch && batch.id !== sweptBatch.current && sweeps && pot && !prefersReducedMotion()) {
      sweptBatch.current = batch.id;
      const to = centre(pot);
      const o = origin();
      const made = ([0, 1] as const).flatMap((i) => {
        const b = betSpots.current[i];
        if (!b) return [];
        const x = b.at.x + o.x;
        const y = b.at.y + o.y;
        return [{ id: batch.id * 10 + i, amount: b.amount, x, y, dx: to.x - x, dy: to.y - y, delay: 80 }];
      });
      if (made.length) {
        setGhosts((g) => [...g, ...made]);
        const ids = made.map((m) => m.id);
        setTimeout(() => setGhosts((g) => g.filter((x) => !ids.includes(x.id))), 800);
      }
    }
    // At the end of a hand the pot slides to the winner's stack (to both on a split).
    const result = batch?.events.find((e) => e.type === "result");
    if (batch && result && result.type === "result" && batch.id !== wonBatch.current && pot && !prefersReducedMotion()) {
      wonBatch.current = batch.id;
      const from = centre(pot);
      const winners = result.winner === "split" ? [0, 1] : [result.winner];
      const delay = runoutOffset(batch.events) + (result.how === "showdown" ? SHOWDOWN_CHIPS_AT : FOLD_CHIPS_AT);
      const made = winners.flatMap((w) => {
        const el = tableRef.current?.querySelector<HTMLElement>(`[data-seat="${w}"]`);
        if (!el) return [];
        const to = centre(el.getBoundingClientRect());
        return [{ id: batch.id * 10 + 5 + w, amount: result.winner === "split" ? result.pot / 2n : result.pot, x: from.x, y: from.y, dx: to.x - from.x, dy: to.y - from.y, delay }];
      });
      if (made.length) {
        setGhosts((g) => [...g, ...made]);
        const ids = made.map((m) => m.id);
        setTimeout(() => setGhosts((g) => g.filter((x) => !ids.includes(x.id))), delay + 900);
      }
    }
    const o = origin();
    betSpots.current = [0, 1].map((i) => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-bet="${i}"]`);
      if (!el || t.bets[i] <= 0n) return null;
      const c = centre(el.getBoundingClientRect());
      return { amount: t.bets[i], at: { x: c.x - o.x, y: c.y - o.y } };
    }) as typeof betSpots.current;

    // The dealer button slides to the new dealer.
    const d = tableRef.current?.querySelector<HTMLElement>(".hd-btn");
    if (d) {
      const c = centre(d.getBoundingClientRect());
      const prev = dealerAt.current;
      if (prev && prev.seat !== t.dealer) flyFrom(d, { x: prev.x + o.x, y: prev.y + o.y }, { duration: 600, spin: 180, scale: 1 });
      dealerAt.current = { seat: t.dealer, x: c.x - o.x, y: c.y - o.y };
    }
  }, [batch, t]);

  // Sound follows the same events as the motion.
  useEffect(() => {
    if (!batch) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, cue: Parameters<typeof sfx>[0]) => timers.push(setTimeout(() => sfx(cue), ms));
    let streetIndex = 0;
    for (const e of batch.events) {
      if (e.type === "action") at(0, e.kind === "check" ? "check" : e.kind === "fold" ? "fold" : "chip");
      else if (e.type === "sweep") at(120, "chip");
      else if (e.type === "deal") {
        [0, 110, 220, 330].forEach((ms) => at(ms, "deal"));
        at(1000, "flip");
      } else if (e.type === "street") {
        const base = 350 + streetIndex * STREET_MS;
        streetIndex++;
        e.cards.forEach((_, k) => {
          at(base + k * 140, "deal");
          at(base + k * 140 + 440, "flip");
        });
      } else if (e.type === "result") {
        const showdown = e.how === "showdown";
        const t0 = runoutOffset(batch.events) + (showdown ? 800 : 200);
        if (showdown) at(t0 - 300, "flip");
        at(t0, e.winner === "split" ? "chip" : e.winner === seat ? "win" : "lose");
        at(t0 + (showdown ? 700 : 250), "chip");
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [batch, seat]);

  const fresh = batch?.events ?? [];
  const dealtNow = fresh.some((e) => e.type === "deal");
  const holeFly = (order: number) => (dealtNow ? { deck: deckRef, delay: order * 110 } : null);
  // Each street dealt in the latest read: where its cards land on the board and when. A run-out deals them one street after another.
  const boardPlan = new Map<number, { delay: number; turn: number }>();
  fresh
    .filter((e) => e.type === "street")
    .forEach((e, k) => {
      if (e.type !== "street") return;
      const from = e.street === "flop" ? 0 : e.street === "turn" ? 3 : 4;
      for (let j = 0; j < e.cards.length; j++) {
        const delay = 350 + k * STREET_MS + j * 140;
        boardPlan.set(from + j, { delay, turn: delay + 440 });
      }
    });
  const boardFly = (i: number) => {
    const p = boardPlan.get(i);
    return p ? { fly: { deck: deckRef, delay: p.delay }, turn: p.turn } : null;
  };
  const revealAt = fresh.some((e) => e.type === "result") ? runoutOffset(fresh) : 0;
  const showdown = showLast && lh.showdown && lh.result !== NO_WINNER;
  const hands = showdown ? ([bestHand(lh.shown[0], lh.board), bestHand(lh.shown[1], lh.board)] as const) : null;
  const winners = !showLast || lh.result === NO_WINNER ? [] : lh.result === SPLIT ? [0, 1] : [lh.result];
  const five = new Set(hands ? winners.flatMap((w) => hands[w].cards) : []);
  const markFor = (card?: number | null): "win" | "dim" | null => (!hands || card === undefined || card === null || card >= NO_CARD ? null : five.has(card) ? "win" : "dim");
  const summary = showLast && lh.result !== NO_WINNER ? resultSummary(lh, seat, hands) : null;
  const tagFor = (i: number) => (!summary ? null : lh.result === SPLIT ? "Split" : lh.result === i ? "Winner" : null);
  const dealingMine = feed.dealing && playing;
  const dealtHand = playing ? t.handNo : lh.handNo;
  const oppState: FlipState = oppCards ? "up" : playing ? "down" : "empty";
  const myHand = myCards && (playing || showLast) && !(feed.dealing && playing) ? bestHand(myCards, board).name : null;
  const oppHand = hands ? hands[opp].name : null;

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
          <FullScreenToggle />
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

      <div className="hdx-stage" style={{ ["--rv" as string]: `${revealAt}ms` }}>
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
          <div className="hdx-felt" data-how={showdown ? "showdown" : "fold"}>
            <Seat
              who="Opponent"
              address={practice ? "Bot" : undefined}
              account={practice ? undefined : accounts[opp]}
              picture={practice ? bots[6] : undefined}
              linked={ended}
              stack={t.stacks[opp] - (feed.settle?.award[opp] ?? 0n)}
              bet={t.bets[opp]}
              dealer={sbSeat === opp}
              active={playing && t.toAct === opp}
              fraction={ringFraction}
              low={ringLow}
              allIn={playing && t.stacks[opp] === 0n}
              missed={t.missed[opp]}
              say={feed.say[opp]}
              label={oppHand}
              tag={tagFor(opp)}
              index={opp}
            >
              {[0, 1].map((i) => (
                <FlipCard key={`o${dealtHand}-${i}`} card={oppCards?.[i]} state={oppState} fly={holeFly(i === 0 ? 0 : 2)} turnDelay={revealAt + i * 120} mark={markFor(oppCards?.[i])} />
              ))}
            </Seat>

            <div className="hdx-mid">
              <div ref={potRef} className="hdx-potslot">
                {summary ? (
                  <div className={`cut hdx-win ${summary.outcome}`} role="status" aria-label={`${summary.title}. ${summary.detail}`}>
                    <span className="hdx-win-icon" aria-hidden="true">
                      {summary.outcome === "win" ? <Trophy size={22} /> : summary.outcome === "split" ? <Handshake size={22} /> : <Flag size={22} />}
                    </span>
                    <span className="hdx-win-t">
                      {ended && <span className="hdx-win-k">Final hand</span>}
                      <b>{summary.title}</b>
                      <span>{summary.detail}</span>
                    </span>
                  </div>
                ) : (
                <div className="cut hdx-pot mono" aria-label={`Pot ${chips(t.pot)} Chips`}>
                  <ChipStack amount={t.pot} piles={t.pot > 1500n ? 3 : t.pot > 400n ? 2 : 1} />
                  <span className="hdx-pot-t">
                    <span className="hdx-pot-l">Pot</span>
                    <b>
                      <CountUp value={Number(t.pot)} format={chips} />
                    </b>
                  </span>
                </div>
                )}
              </div>
              <div className="hdx-board" aria-label="Board">
                {[0, 1, 2, 3, 4].map((i) => {
                  const f = boardFly(i);
                  const known = board[i] !== undefined && board[i] < 52;
                  return <FlipCard key={`b${t.handNo}-${i}`} card={board[i]} state={known ? "up" : "empty"} size="lg" fly={f?.fly} turnDelay={f?.turn ?? 0} mark={markFor(board[i])} />;
                })}
              </div>
            </div>

            <Seat
              who="You"
              account={practice ? undefined : accounts[seat]}
              picture={practice ? bots[2] : undefined}
              stack={t.stacks[seat] - (feed.settle?.award[seat] ?? 0n)}
              bet={t.bets[seat]}
              dealer={sbSeat === seat}
              active={myTurn}
              fraction={ringFraction}
              low={ringLow}
              allIn={playing && t.stacks[seat] === 0n}
              missed={t.missed[seat]}
              say={feed.say[seat]}
              label={myHand}
              tag={tagFor(seat)}
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
                  mark={markFor(myCards?.[i])}
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
        {ended && endPanel && (
          <div className="hdx-end" role="dialog" aria-label="Match over">
            {endPanel}
          </div>
        )}
        {ghosts.map((g) => (
          <div key={g.id} className="hd-ghost" style={{ left: g.x, top: g.y, animationDelay: `${g.delay}ms`, ["--dx" as string]: `${g.dx}px`, ["--dy" as string]: `${g.dy}px` }} aria-hidden="true">
            <ChipStack amount={g.amount} />
          </div>
        ))}
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
