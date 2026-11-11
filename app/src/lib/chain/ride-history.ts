/** A stored ride (`ride-record.ts`) put to use: its replay record, and the lines a Backer reads about it. */
import { hexToBytes } from "../../games/railcar/engine";
import type { RideRecord } from "../../games/railcar/replay";
import { rideLine } from "../../games/railcar/words";
import { fmtGemas } from "../format";
import type { HistoryRow } from "./history";
import type { StoredRide } from "./ride-record";

/**
 * The first car that rode under "later Tells are not promised" (decisions Q39). Cars before it showed every Tell, and their
 * history replays that way. 0 where the rule was there from the first car; on devnet it is the next car at the upgrade.
 */
export const UNPROMISED_TELLS_FROM_CAR = BigInt(process.env.NEXT_PUBLIC_RAILCAR_UNPROMISED_TELLS_FROM_CAR || "0");

/** The replayable record of a stored ride, or null when the Match is not a ride. */
export function rideRecordOf(m: { entry: number; ride?: StoredRide | null }): RideRecord | null {
  const r = m.ride;
  if (!r) return null;
  return {
    entry: BigInt(m.entry),
    outcome: r.outcome,
    reason: r.reason,
    draw: r.draw ? hexToBytes(r.draw) : null,
    brakes: r.brakes,
    seats: r.seats.map((s) => ({ seat: s.seat, player: s.player, funder: s.funder, order: s.order, jumpMs: s.jumpMs, refund: BigInt(s.refund) })),
    places: r.places.map((p) => ({ seat: p.seat, won: BigInt(p.won) })),
    fees: BigInt(r.fees[0] + r.fees[1] + r.fees[2]),
    everyTell: BigInt(r.carNo) < UNPROMISED_TELLS_FROM_CAR,
  };
}

/**
 * The ride a used Railcar Offer funded, from its Backer's history: the newest ride the Backer funded for the Offer's
 * Player that opened before the Offer's use-by (a car can open before the Offer is accepted, never after it lapses).
 */
export function rideOfOffer(rows: HistoryRow[], offer: { player: string; useBy: number }): HistoryRow | null {
  return rows.filter((r) => r.game === "railcar" && r.role === "backer" && r.backing?.other === offer.player && r.at <= offer.useBy * 1000).reduce<HistoryRow | null>((best, r) => (!best || r.at > best.at ? r : best), null);
}

/** What a ride did with the Backer's Gemas: the entry back first, then their share of any winnings. */
export function backerRideLine(r: HistoryRow): string {
  const entry = fmtGemas(r.entry);
  const ride = r.ride;
  if (!ride || ride.kind === "refund") return `Ride refunded: your ${entry} back`;
  const how = rideLine(ride);
  if (ride.kind === "place") return `${how}: your ${entry} back, then +${fmtGemas(r.delta)} of the winnings`;
  if (ride.kind === "early") return `${how}: ${fmtGemas(r.entry + r.delta)} of your ${entry} back`;
  return `${how}: your ${entry} is lost`;
}
