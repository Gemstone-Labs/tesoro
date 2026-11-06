"use client";

import { Button, Card, Chip } from "@/components/ui";
import { PlayerName } from "@/components/account/Player";
import type { ChainOffer, ChainRequest } from "@/lib/chain/backing";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { backedGameName } from "@/lib/backing/games";
import { matchHref, type HistoryRow } from "@/lib/chain/history";
import { backerRideLine } from "@/lib/chain/ride-history";

export function MyOffer({
  offer,
  ride = null,
  requests,
  nowMs,
  busy,
  onCancel,
  onRelease,
  onRefund,
}: {
  offer: ChainOffer;
  /** A used Railcar Offer's ride from the Backer's Match history (`rideOfOffer`); null until it is there. */
  ride?: HistoryRow | null;
  requests: Map<string, ChainRequest>;
  nowMs: number;
  busy: string | null;
  onCancel: () => void;
  onRelease: () => void;
  onRefund: () => void;
}) {
  const nowSecs = nowMs / 1000;
  const reserved = offer.lines.reduce((s, l) => s + Number(l.amount), 0);
  const lapsed = (offer.status === "open" && nowSecs >= offer.expiresAt) || (offer.status === "accepted" && nowSecs >= offer.useBy);
  const playerKey = offer.player ?? requests.get(offer.request)?.player ?? null;
  const key = offer.address.toBase58();
  const status =
    offer.status === "consumed"
      ? offer.refundableMatchId !== null
        ? "Nobody joined this Match and its time is up: refund it to get your Gemas back"
        : offer.game === "railcar"
          ? ride
            ? backerRideLine(ride)
            : "Boarded: your Gemas ride in the Player's seat. A step-off or an early Jump sends them back to you"
          : "Match started: your Gemas are in the Pot"
      : lapsed
        ? "Expired: release your reserved Gemas"
        : offer.status === "accepted"
          ? <>Accepted by <PlayerName account={offer.player ?? ""} /> · they have {timeLeft(offer.useBy, nowMs).replace(" left", "")} to start</>
          : <>Waiting for {playerKey ? <PlayerName account={playerKey} /> : "the Player"} · {timeLeft(offer.expiresAt, nowMs)}</>;
  return (
    <Card as="article" aria-label="Your Offer">
      <div className="stack">
        <div className="spread">
          <span className="row-body">
            <span className="row-title">Offer · {fmtGemas(offer.entry)}</span>
            <span className="row-meta">{backedGameName(offer.game)} · Player keeps {offer.shareBps / 100}% of the {offer.game === "railcar" ? "winnings" : "surplus"}</span>
          </span>
          {offer.status === "consumed" ? <Chip tone="money">Used</Chip> : <Chip tone="strong">{fmtGemas(reserved)} reserved</Chip>}
        </div>
        <p className="note">{status}</p>
        <div className="hstack wrap">
          {offer.status === "consumed" && offer.matchId !== null && (
            <Button size="sm" href={`/play/match/${offer.matchId.toString()}`}>See the Match</Button>
          )}
          {offer.status === "consumed" && ride && (
            <Button size="sm" href={matchHref(ride)}>See the ride</Button>
          )}
          {offer.refundableMatchId !== null && (
            <Button size="sm" disabled={busy !== null} onClick={onRefund}>
              {busy === `rf-${key}` ? "Refunding…" : "Refund Match"}
            </Button>
          )}
          {lapsed && (
            <Button size="sm" disabled={busy !== null} onClick={onRelease}>
              {busy === `ex-${key}` ? "Releasing…" : "Release Gemas"}
            </Button>
          )}
          {!lapsed && (offer.status === "open" || offer.status === "accepted") && (
            <Button size="sm" disabled={busy !== null} onClick={onCancel}>
              {busy === `co-${key}` ? "Cancelling…" : "Cancel Offer"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
