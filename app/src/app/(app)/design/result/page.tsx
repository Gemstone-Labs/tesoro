"use client";

import { Suspense } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult, type Outcome } from "@/components/match/MatchResult";
import { DEV_WALLET } from "@/lib/chain/config";
import { match } from "@/lib/chain/fixture";
import { backerDelta, matchDelta } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";

/** DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1): every Match result variant on fixtures. `?case=won|lost|draw|refunded|backed-player|backed-lost|backer-won|backer-lost|holdem-won|holdem-lost`. */
function Preview() {
  const c = useSearchParams().get("case") ?? "won";
  const game: GameId = c.startsWith("holdem") ? "holdem" : "block-puzzle";
  const won = !["lost", "backed-lost", "backer-lost", "holdem-lost"].includes(c);
  let m: ChainMatch = match(game, 1000, won, 2, [151, 42]);
  if (c === "draw" && m.session) m = { ...m, session: { ...m.session, result: "draw", scores: [88, 88] } };
  if (c === "refunded") m = { ...m, status: "refunded", session: null, winner: null };
  const asBacker = c.startsWith("backer");
  if (c.startsWith("backed") || asBacker) {
    const me = m.sides[0].player;
    m = {
      ...m,
      backing: { seat: 0, player: asBacker ? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" : me, funder: asBacker ? me : "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", shareBps: 4000 },
      seat: asBacker ? null : 0,
      backerSeat: asBacker ? 0 : null,
    };
  }
  const outcome: Outcome = c === "refunded" ? "refunded" : c === "draw" ? "draw" : won ? "won" : "lost";
  const delta = asBacker && m.backing ? backerDelta({ ...m, backerSeat: 0, shareBps: 4000 }) : matchDelta(m);
  const fee = Math.floor(m.entry * 2 * 0.05);
  return (
    <MatchResult
      game={game}
      outcome={outcome}
      delta={delta}
      entry={m.entry}
      fee={fee}
      role={asBacker ? "backer" : "player"}
      backed={!!m.backing}
      playAgainHref="/play/queue"
      split={m.backing ? <BackingSplit m={m} /> : undefined}
    />
  );
}

export default function ResultPreview() {
  if (!DEV_WALLET) notFound();
  return (
    <Suspense>
      <Preview />
    </Suspense>
  );
}
