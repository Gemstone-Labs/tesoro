"use client";

import { cardText } from "@/games/holdem/cards";
import { useEndState, type EndStateRead } from "@/lib/end-state";
import type { ChainMatch } from "@/lib/chain/read";

/**
 * The kept end state of a finished Hold'em or Block Burst Match (Trading Duel has its own, in DuelSpectate): the last board and
 * the hands shown, or the final scores. Never an endless loader: no end state means the line says the board is gone.
 */
export function EndStateNote({ m }: { m: ChainMatch }) {
  const game = m.game === "holdem" ? "holdem" : m.game === "block-puzzle" ? "block-puzzle" : null;
  const finished = m.status === "settled" || m.status === "refunded";
  const end = useEndState(m.address.toBase58(), finished && !!game, game ?? "holdem");
  if (!game || !finished) return null;
  return <EndStateLine end={end} />;
}

export function EndStateLine({ end }: { end: EndStateRead }) {
  if (end.status === "loading") return <p className="mr-copy">Loading the board…</p>;
  if (end.status === "none") return <p className="mr-copy">The board of this Match is no longer available. The result above is final.</p>;
  const s = end.state;
  if (s.game === "holdem") {
    const board = s.board.length ? s.board.map(cardText).join(", ") : "no cards on the board";
    return (
      <p className="mr-copy">
        Last hand ({s.handNo}): {board}.{s.shown ? ` Hands shown: ${s.shown.map((h) => h.map(cardText).join(" and ")).join(" against ")}.` : " Nobody showed their hand."}
      </p>
    );
  }
  if (s.game === "block-puzzle") {
    return (
      <p className="mr-copy">
        Final scores: {s.scores[0]} ({s.moves[0]} moves) against {s.scores[1]} ({s.moves[1]} moves).
      </p>
    );
  }
  return null;
}
