"use client";

import Link from "next/link";
import { useAccount } from "@/lib/account";
import { useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { SkeletonCards } from "@/components/ui";
import { usePlayerLabel } from "@/components/account/Player";
import { RequestCard } from "@/components/backing/RequestCard";
import { Rail } from "./Rail";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { RailA, RailB, RailC, RailD, RailE, type Item } from "./BackPlayerRail.prototype";

const VARIANTS = [
  { key: "C1", name: "Cards · P&L line" },
  { key: "C2", name: "Cards · P&L won/lost bar" },
  { key: "C3", name: "Cards · P&L figures" },
  { key: "C", name: "Cards · W/L dots (round 1)" },
  { key: "now", name: "Current" },
  { key: "A", name: "Spotlight + bench" },
  { key: "B", name: "Scouting ledger" },
  { key: "D", name: "Deal desk" },
  { key: "E", name: "Payoff tickets" },
] as const;
const C1 = (p: { items: Item[] }) => <RailC {...p} pnl="spark" />;
const C2 = (p: { items: Item[] }) => <RailC {...p} pnl="split" />;
const C3 = (p: { items: Item[] }) => <RailC {...p} pnl="figures" />;
const CDots = (p: { items: Item[] }) => <RailC {...p} pnl="dots" />;
const PROTO = { A: RailA, B: RailB, C: CDots, C1, C2, C3, D: RailD, E: RailE } as const;

/** BACK A PLAYER: live Requests from Solana devnet with the Player's real record. The avatar and name lead to their Account; Offer opens the Backing flow. */
export function BackPlayerRail() {
  const { board, loading, error, refresh } = useBackingBoard();
  const { snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const variant = usePrototypeVariant(VARIANTS.map((v) => v.key));
  const live = (board?.requests ?? []).filter((r) => r.live);
  const requests = live.slice(0, 3);
  const switcher = <PrototypeSwitcher variants={VARIANTS} />;

  if (variant !== "now" && board && live.length > 0) {
    const V = PROTO[variant];
    return (
      <>
        <V items={live.map((r) => ({ r, key: r.address.toBase58(), mine: r.player === me }))} />
        {switcher}
      </>
    );
  }

  return (
    <>
    {switcher}
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3}>
      {loading && !board && <SkeletonCards className="rq" label="Loading Requests…" />}
      {error && !board && (
        <p className="rail-empty">
          Requests couldn’t be loaded. <button type="button" onClick={() => void refresh()}>Try again</button>
        </p>
      )}
      {board && requests.length === 0 && (
        <p className="rail-empty">
          No Players are asking to be backed right now. <Link href="/backing">Post a Request</Link> or check back soon.
        </p>
      )}
      {requests.map((r) => {
        const key = r.address.toBase58();
        const mine = r.player === me;
        return (
          <RequestCard
            key={key}
            r={r}
            action={
              mine ? (
                <Link href={`/backing#${key}`} className="cut cut-btn btn neutral" aria-label="Your Request">
                  Yours
                </Link>
              ) : (
                <OfferLink href={`/backing#${key}`} player={r.player} label={`in ${GAME_NAMES[r.game]} for ${fmtGemas(r.entry)} Gemas`} />
              )
            }
          />
        );
      })}
    </Rail>
    </>
  );
}

function OfferLink({ href, player, label }: { href: string; player: string; label: string }) {
  const name = usePlayerLabel(player);
  return (
    <Link href={href} className="cut cut-btn btn money" aria-label={`Offer to back ${name} ${label}`}>
      Offer
    </Link>
  );
}
