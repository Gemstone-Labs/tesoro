/**
 * A Railcar ride as the Match history keeps it (`match_history.ride`), written from the `finalize` transaction's events:
 * Railcar's `RideSettled` (the draw, every Brake, every seat) and core's places. Amounts are whole Gemas as numbers.
 */
import type { RideReason } from "../../games/railcar/chain";
import { hexToBytes } from "../../games/railcar/engine";
import type { RideRecord } from "../../games/railcar/replay";
import { rideLine } from "../../games/railcar/words";
import { fmtGemas } from "../format";
import type { HistoryRow } from "./history";

export interface StoredRide {
  carNo: string;
  outcome: "placed" | "refund";
  reason: RideReason | "outage";
  /** Hex of the VRF output; null when it never came. */
  draw: string | null;
  brakes: { seat: number; ms: number }[];
  seats: { seat: number; player: string; funder: string; shareBps: number; order: number; jumpMs: number; refund: number }[];
  /** First place (last off) first. */
  places: { place: number; seat: number; player: string; funder: string; shareBps: number; won: number }[];
  /** Platform, Studio, Leaderboard. */
  fees: [number, number, number];
}

/** One party's part in a ride, as its history row carries it. */
export interface RideRole {
  seated: number;
  kind: "place" | "early" | "aboard" | "refund";
  /** 1 = last off. */
  place?: number;
  jumpMs?: number;
}

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
  };
}

/** Each seat's part in the ride: a place (last three off), an early Jump, aboard at Impact, or refunded. */
export function rideRoles(r: StoredRide): Map<number, RideRole> {
  const seated = r.seats.length;
  const placeOf = new Map(r.places.map((p) => [p.seat, p.place]));
  return new Map<number, RideRole>(
    r.seats.map((s): [number, RideRole] => {
      if (r.outcome === "refund") return [s.seat, { seated, kind: "refund" }];
      const place = placeOf.get(s.seat);
      if (place) return [s.seat, { seated, kind: "place", place, jumpMs: s.jumpMs }];
      return [s.seat, s.order === 0 ? { seated, kind: "aboard" } : { seated, kind: "early", jumpMs: s.jumpMs }];
    }),
  );
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
