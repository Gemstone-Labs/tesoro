"use client";

import Image from "next/image";
import Link from "next/link";
import { useAccount } from "@/lib/account";
import { avatarFor } from "@/lib/art";
import type { ChainRequest } from "@/lib/chain/backing";
import { shortKey, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { GemaMark, SkeletonCards } from "@/components/ui";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";

/** "38 Matches · 61% won": the win rate always carries its sample size. */
function recordShort(r: ChainRequest["record"]): string {
  if (r.matches === 0) return "New Player · no settled Matches";
  return `${r.matches} ${r.matches === 1 ? "Match" : "Matches"} · ${Math.round((r.wins / r.matches) * 100)}% won`;
}

/** BACK A PLAYER: live Requests from Solana devnet with the Player's real record. Offer opens the Backing flow. */
export function BackPlayerRail() {
  const { board, loading } = useBackingBoard();
  const { snapshot } = useAccount();
  const { query } = useSearch();
  const me = snapshot?.accountKey.toBase58();
  const requests = (board?.requests ?? []).filter((r) => r.live && (!query.trim() || matchesQuery(GAME_NAMES[r.game], query))).slice(0, 3);

  return (
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3}>
      {loading && !board && <SkeletonCards className="player" label="Reading Requests from Solana devnet…" />}
      {board && requests.length === 0 && (
        <p className="rail-empty">
          {query.trim() ? "No Requests match your search." : "No Players are asking to be backed right now."} <Link href="/backing">Post a Request</Link> or check back soon.
        </p>
      )}
      {requests.map((r) => {
        const key = r.address.toBase58();
        const mine = r.player === me;
        return (
          <article key={key} className="cut cut-card player">
            <span className="cut cut-btn avatar player-avatar">
              <Image src={avatarFor(r.player)} alt="" width={78} height={78} />
            </span>
            <div className="player-info">
              <strong>{shortKey(r.player)}</strong>
              <span>{GAME_NAMES[r.game]} · {recordShort(r.record)}</span>
            </div>
            <div className="player-side">
              <b className="tnum">
                <GemaMark size={18} />
                {fmtGemas(r.entry)}
              </b>
              {mine ? (
                <Link href={`/backing#${key}`} className="cut cut-btn btn neutral player-offer" aria-label="Your Request">
                  Yours
                </Link>
              ) : (
                <Link href={`/backing#${key}`} className="cut cut-btn btn money player-offer" aria-label={`Offer to back ${shortKey(r.player)} in ${GAME_NAMES[r.game]} for ${fmtGemas(r.entry)} Gemas`}>
                  Offer
                </Link>
              )}
            </div>
          </article>
        );
      })}
    </Rail>
  );
}
