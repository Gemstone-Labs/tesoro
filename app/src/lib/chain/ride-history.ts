/** A stored ride (`ride-record.ts`) put to use: its replay record, and the lines a Backer reads about it. */
import { RULES_Q39, RULES_Q40, RULES_ROUND1, hexToBytes, type RulesVersion } from "../../games/railcar/engine";
import type { RideRecord } from "../../games/railcar/replay";
import { rideLine } from "../../games/railcar/words";
import { fmtGemas } from "../format";
import type { HistoryRow } from "./history";
import type { StoredRide } from "./ride-record";

/**
 * The first car that rode under "later Tells are not promised" (decisions Q39), for rides revealed before the program
 * recorded the rules on the car. Cars before it showed every Tell, and their history replays that way. 0 where the rule
 * was there from the first car; on devnet it is the next car at the upgrade.
 */
export const UNPROMISED_TELLS_FROM_CAR = BigInt(process.env.NEXT_PUBLIC_RAILCAR_UNPROMISED_TELLS_FROM_CAR || "0");

/** Railcar's entry since rules round 2; a stored ride at it with no rules byte is a round 2 ride. */
const ROUND2_ENTRY = 100;

/**
 * The rules a stored ride replays under: what the program recorded; else, for a ride stored without the byte (revealed
 * before the program wrote it, or ingested by the staging sidecar's older decoder, which drops the tail and whose row
 * is never ingested again), round 2 when it rode at the 100-Gema entry, otherwise round 1 or Q39 by car number.
 */
export const rulesOf = (r: Pick<StoredRide, "carNo" | "rules"> & { entry: number }, cutoff = UNPROMISED_TELLS_FROM_CAR): RulesVersion =>
  r.rules ?? (r.entry === ROUND2_ENTRY ? RULES_Q40 : BigInt(r.carNo) < cutoff ? RULES_ROUND1 : RULES_Q39);

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
    rules: rulesOf({ ...r, entry: m.entry }),
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
