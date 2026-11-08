"use client";

import Image from "next/image";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { NO_CARD, NO_WINNER, SPLIT } from "./chain";
import { PlayingCard } from "./cards";
import type { HandLog, LogAct, LogRow } from "./handlog";
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

/**
 * The hand log as a short story: each street with the cards it dealt, each action with who made it,
 * and the result at the end. `players` is indexed by seat; `hole` is this Player's two cards.
 */
export function HandLogView({ log, seat, players, hole }: { log: HandLog; seat: 0 | 1; players: [LogPlayer, LogPlayer]; hole?: readonly number[] | null }) {
  if (log.streets.length === 0) return <p className="meta">The hand log fills as the hand is played.</p>;
  const opp = (1 - seat) as 0 | 1;
  return (
    <div className="hl">
      <p className="hl-hand-no meta">Hand {log.hand}</p>
      {log.streets.map((s, i) => {
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
              (log.done || i < log.streets.length - 1) && !s.rows.some((r) => r.act === "showdown") && <p className="hl-none meta">No bets</p>
            )}
          </section>
        );
      })}
      {log.end && <Outcome end={log.end} seat={seat} players={players} />}
    </div>
  );
}
