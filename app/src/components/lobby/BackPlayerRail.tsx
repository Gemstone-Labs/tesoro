"use client";

import Link from "next/link";
import { useAccount } from "@/lib/account";
import { recordShort, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { GemaMark, SkeletonCards } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { Suspense } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { CardBanner, CardBannerRecord, CardRecord, CardRing, PLAYER_CARD_VARIANTS } from "./PlayerCard.prototype";

/** BACK A PLAYER: live Requests from Solana devnet with the Player's real record. The name leads to their Account; Offer opens the Backing flow. */
// PROTOTYPE: variant switcher around the rail (see PlayerCard.prototype.tsx).
export function BackPlayerRail() {
  return (
    <Suspense>
      <BackPlayerRailInner />
      <PrototypeSwitcher variants={[...PLAYER_CARD_VARIANTS]} />
    </Suspense>
  );
}

function BackPlayerRailInner() {
  const variant = usePrototypeVariant(PLAYER_CARD_VARIANTS.map((v) => v.key));
  const { board, loading, error, refresh } = useBackingBoard();
  const { snapshot } = useAccount();
  const { query } = useSearch();
  const me = snapshot?.accountKey.toBase58();
  const requests = (board?.requests ?? []).filter((r) => r.live && (!query.trim() || matchesQuery(GAME_NAMES[r.game], query))).slice(0, 3);

  return (
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3}>
      {loading && !board && <SkeletonCards className="player" label="Loading Requests…" />}
      {error && !board && (
        <p className="rail-empty">
          Requests couldn’t be loaded. <button type="button" onClick={() => void refresh()}>Try again</button>
        </p>
      )}
      {board && requests.length === 0 && (
        <p className="rail-empty">
          {query.trim() ? "No Requests match your search." : "No Players are asking to be backed right now."} <Link href="/backing">Post a Request</Link> or check back soon.
        </p>
      )}
      {requests.map((r) => {
        const key = r.address.toBase58();
        const mine = r.player === me;
        const action = mine ? (
          <Link href={`/backing#${key}`} className="cut cut-btn btn neutral player-offer" aria-label="Your Request">
            Yours
          </Link>
        ) : (
          <OfferLink href={`/backing#${key}`} player={r.player} label={`in ${GAME_NAMES[r.game]} for ${fmtGemas(r.entry)} Gemas`} />
        );
        if (variant === "D") return <CardBannerRecord key={key} r={r} action={action} />;
        if (variant === "A") return <CardRecord key={key} r={r} action={action} />;
        if (variant === "B") return <CardBanner key={key} r={r} action={action} />;
        if (variant === "C") return <CardRing key={key} r={r} action={action} />;
        return (
          <article key={key} className="cut cut-card player">
            <AccountLink account={r.player} decorative className="cut cut-btn avatar player-avatar">
              <PlayerAvatar account={r.player} size={78} />
            </AccountLink>
            <div className="player-info">
              <strong>
                <AccountLink account={r.player} />
              </strong>
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
                <OfferLink href={`/backing#${key}`} player={r.player} label={`in ${GAME_NAMES[r.game]} for ${fmtGemas(r.entry)} Gemas`} />
              )}
            </div>
          </article>
        );
      })}
    </Rail>
  );
}

function OfferLink({ href, player, label }: { href: string; player: string; label: string }) {
  const name = usePlayerLabel(player);
  return (
    <Link href={href} className="cut cut-btn btn money player-offer" aria-label={`Offer to back ${name} ${label}`}>
      Offer
    </Link>
  );
}
