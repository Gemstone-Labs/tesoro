/**
 * A Railcar ride as the Match history keeps it (`match_history.ride`): Railcar's `RideRevealed` from `reveal_ride` (the
 * draw, every Brake, every seat) and core's places from the run. Amounts are whole Gemas as numbers.
 * Types only: the history ingest (also compiled by the keeper) reads them without the app's history helpers.
 */
import type { RideReason } from "../../games/railcar/chain";

export interface StoredRide {
  carNo: string;
  outcome: "placed" | "refund";
  reason: RideReason | "outage";
  /** Hex of the VRF output; null when it never came. */
  draw: string | null;
  brakes: { seat: number; ms: number }[];
  seats: { seat: number; player: string; funder: string; shareBps: number; order: number; jumpMs: number; refund: number }[];
  /** First place (last off) first; `shareBps` is core's place share (6000 / 2500 / 1500), not a Backing's Offer share (that is the seat's). */
  places: { place: number; seat: number; player: string; funder: string; shareBps: number; won: number }[];
  /** Platform, Studio, Leaderboard. */
  fees: [number, number, number];
  /** The rules the car left under (1 round 1, 2 Q39, 3 round 2); missing on rides revealed before the program recorded it. */
  rules?: 1 | 2 | 3;
}

/** One party's part in a ride, as its history row carries it. */
export interface RideRole {
  seated: number;
  kind: "place" | "early" | "aboard" | "refund";
  /** 1 = last off. */
  place?: number;
  jumpMs?: number;
}
