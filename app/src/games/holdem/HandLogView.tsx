"use client";

import Image from "next/image";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { NO_CARD, NO_WINNER, SPLIT } from "./chain";
import { PlayingCard } from "./cards";
import type { HandLog, LogAct, LogRow, PastHand } from "./handlog";
import { bestHand, resultSummary } from "./reading";

const chips = (n: bigint) => Number(n).toLocaleString("en-US");

/** A seat as the log shows it: a Player's Account, or a practice picture and label. */
export interface LogPlayer {
  account?: string;
  picture?: string;
  label: string;
}

const VERB: Record<Exclude<LogAct, "board" | "showdown">, string> = {
  "small-blind": "Small blind",
  "big-blind": "Big blind",
  check: "Check",
  call: "Call",
  bet: "Bet",
  raise: "Raise to",
  fold: "Fold",
};

function Face({ player }: { player: LogPlayer }) {
  if (player.account) return <PlayerAvatar account={player.account} size={28} className="hl-ava" />;
  if (player.picture) return <Image className="hl-ava" src={player.picture} alt="" width={28} height={28} />;
  return <span className="hl-ava" aria-hidden="true" />;
}

function Cards({ cards }: { cards: readonly number[] }) {
  return (
    <span className="hl-cards">
      {cards.map((c, i) => (
        <PlayingCard key={i} card={c} />
      ))}
    </span>
  );
}

function Action({ row, player, mine }: { row: LogRow; player: LogPlayer; mine: boolean }) {
  if (row.act === "board" || row.act === "showdown") return null;
  const tone = row.allIn ? "allin" : row.act;
  return (
    <li className={`hl-act${mine ? " mine" : ""}`}>
      <Face player={player} />
      <span className="hl-who">{mine ? "You" : player.account ? <PlayerName account={player.account} /> : player.label}</span>
      <span className={`hl-verb ${tone}`}>
        {VERB[row.act]}
        {row.amount !== undefined && <b className="mono">{chips(row.amount)}</b>}
        {row.allIn && <em>All-in</em>}
      </span>
    </li>
  );
}

/** How the hand ended: who won what, and at a showdown both hands. */
function Outcome({ end, seat, players }: { end: NonNullable<HandLog["end"]>; seat: 0 | 1; players: [LogPlayer, LogPlayer] }) {
  if (end.result === NO_WINNER) return null;
  const opp = (1 - seat) as 0 | 1;
  const shown = end.showdown && end.shown[0][0] !== NO_CARD && end.shown[1][0] !== NO_CARD;
  const hands = shown ? ([bestHand(end.shown[0], end.board), bestHand(end.shown[1], end.board)] as const) : null;
  const summary = resultSummary(end, seat, hands);
  const won = (i: number) => end.result === SPLIT || end.result === i;
  return (
    <section className={`cut hl-end ${summary.outcome}`} aria-label="Result">
      <strong>{summary.title}</strong>
      <span className="meta">{summary.detail}</span>
      {hands && (
        <div className="hl-hands">
          {([seat, opp] as const).map((i) => (
            <div key={i} className={`hl-hand${won(i) ? " won" : ""}`}>
              <span className="hl-hand-who">
                <Face player={players[i]} />
                {i === seat ? "You" : players[i].account ? <PlayerName account={players[i].account} /> : players[i].label}
              </span>
              <Cards cards={end.shown[i]} />
              <span className="hl-hand-name">{hands[i].name}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** One hand's streets, one block each, then how it ended. `live` while the hand is still being played. */
function HandStreets({ hand, live, seat, players, hole }: { hand: PastHand; live: boolean; seat: 0 | 1; players: [LogPlayer, LogPlayer]; hole?: readonly number[] | null }) {
  const opp = (1 - seat) as 0 | 1;
  return (
    <>
      {hand.streets.map((s, i) => {
        const board = s.rows.find((r) => r.act === "board")?.cards;
        const first = i === 0 && hole && hole[0] !== NO_CARD;
        const acts = s.rows.filter((r) => r.act !== "board" && r.act !== "showdown");
        return (
          <section key={`${s.name}-${i}`} className="hl-street" aria-label={s.name}>
            <header className="hl-street-head">
              <span className="hl-street-name">{s.name}</span>
              {board && <Cards cards={board} />}
              {first && (
                <span className="hl-yours">
                  <small>Your cards</small>
                  <Cards cards={hole} />
                </span>
              )}
            </header>
            {acts.length > 0 ? (
              <ol className="hl-acts">
                {acts.map((r, j) => (
                  <Action key={j} row={r} player={players[r.who === "you" ? seat : opp]} mine={r.who === "you"} />
                ))}
              </ol>
            ) : (
              (!live || i < hand.streets.length - 1) && !s.rows.some((r) => r.act === "showdown") && <p className="hl-none meta">No bets</p>
            )}
          </section>
        );
      })}
      {hand.end && <Outcome end={hand.end} seat={seat} players={players} />}
    </>
  );
}

/** A finished hand's one-line headline ("You win 300 Chips"), from how it ended. */
function headline(end: PastHand["end"], seat: 0 | 1): string | null {
  if (!end || end.result === NO_WINNER) return null;
  return resultSummary(end, seat, null).title;
}

/**
 * The hand log as a short story: each street with the cards it dealt, each action with who made it,
 * and the result at the end. The hand being played comes first; finished hands follow, newest open.
 * `players` is indexed by seat; `holes` holds this Player's two cards by hand number.
 */
export function HandLogView({ log, seat, players, holes }: { log: HandLog; seat: 0 | 1; players: [LogPlayer, LogPlayer]; holes: Readonly<Record<number, readonly number[]>> }) {
  const current = log.streets.length > 0;
  if (!current && log.past.length === 0) return <p className="meta">The hand log fills as the hand is played.</p>;
  return (
    <div className="hl">
      {current && (
        <>
          <p className="hl-hand-no meta">Hand {log.hand}</p>
          <HandStreets hand={log} live={!log.done} seat={seat} players={players} hole={holes[log.hand]} />
        </>
      )}
      {log.past.length > 0 && <p className="hl-hand-no meta hl-earlier">Earlier hands</p>}
      {log.past.map((h, i) => {
        const title = headline(h.end, seat);
        const won = h.end && (h.end.result === seat || h.end.result === SPLIT);
        return (
          <details key={h.hand} className="hl-past" open={i === 0 && !current}>
            <summary>
              <span className="hl-past-no">Hand {h.hand}</span>
              {holes[h.hand] && <Cards cards={holes[h.hand]} />}
              {title && <span className={`hl-past-result${won ? " won" : ""}`}>{title}</span>}
            </summary>
            <div className="hl-past-body">
              <HandStreets hand={h} live={false} seat={seat} players={players} hole={holes[h.hand]} />
            </div>
          </details>
        );
      })}
    </div>
  );
}
