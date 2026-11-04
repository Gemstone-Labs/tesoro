/**
 * Railcar's client rules, pure: which car the Queue boards, when a car is due to leave, how often a page signals, and the
 * next step a Player's page takes from boarding to the last close. The hook (useRailcar) reads the chain and sends what
 * these say.
 */
import type { PublicKey } from "@solana/web3.js";
import { boardingEnds, joinPage, type CarView, type SeatPageView } from "../../lib/chain/many-seat";
import { COUNTDOWN_SECS, NO_SEAT, type RailcarConfigView, type TableView } from "./chain";

export type QueueChoice =
  | { kind: "join"; car: PublicKey; carNo: bigint; page: number }
  /** No car takes seats: open the next one (`departFirst`: a full car that has not left yet leaves in the same transaction). */
  | { kind: "open"; carNo: bigint; departFirst: { car: PublicKey; carNo: bigint } | null }
  /** The Player already has a seat in the boarding car. */
  | { kind: "seated"; car: PublicKey; carNo: bigint }
  /** The Offer's Backer already has a seat in this car: the Offer boards the next one. */
  | { kind: "backer-seated" };

export interface QueueFacts {
  config: RailcarConfigView;
  /** The car `config.boardingMatch` names, with its pages (null before the first car or when it is gone). */
  boarding: { car: CarView; carNo: bigint; pages: SeatPageView[] } | null;
  now: number;
  /** The Player has a seat mark in the boarding car. */
  mine: boolean;
  /** Boarding with an Offer whose Backer has a mark in the boarding car. */
  backerSeated?: boolean;
}

/** One Railcar Queue at 500 Gemas: board the car that is boarding, or open the next one. */
export function queueChoice(f: QueueFacts): QueueChoice {
  const b = f.boarding;
  const open = b !== null && b.car.stage === "boarding" && f.now < boardingEnds(b.car);
  if (!open) return { kind: "open", carNo: f.config.nextCar, departFirst: null };
  if (f.mine) return { kind: "seated", car: b.car.address, carNo: b.carNo };
  if (f.backerSeated) return { kind: "backer-seated" };
  if (b.car.seated >= b.car.maxSeats) return { kind: "open", carNo: f.config.nextCar, departFirst: { car: b.car.address, carNo: b.carNo } };
  return { kind: "join", car: b.car.address, carNo: b.carNo, page: joinPage(b.car, b.pages) };
}

/** Boarding steps: an entry of more lines than one transaction draws goes through an Entry Ticket first. */
export const boardingSteps = (needsTicket: boolean): ("stage-ticket" | "board")[] => (needsTicket ? ["stage-ticket", "board"] : ["board"]);

/** `check_departure`'s rule (decision Q30): at once when full; else 30 s after the first time 5 boarded, with 5 or more aboard. */
export function departureDue(car: Pick<CarView, "stage" | "seated" | "maxSeats" | "minSeats" | "firstMinAt" | "deadlineAbs">, now: number): boolean {
  if (car.stage !== "boarding" || now >= boardingEnds(car)) return false;
  if (car.seated >= car.maxSeats) return true;
  return car.firstMinAt !== 0 && car.seated >= car.minSeats && now >= car.firstMinAt + COUNTDOWN_SECS;
}

/** The time the countdown ends (unix seconds), once 5 have boarded; null before. */
export const departsAt = (car: Pick<CarView, "firstMinAt">): number | null => (car.firstMinAt ? car.firstMinAt + COUNTDOWN_SECS : null);

/** Signals the car gets per second from every open page together (spec: about 5). */
export const SIGNALS_PER_SEC = 5;
/** A page never signals more often than this. */
export const MIN_SIGNAL_MS = 500;

/** How long a Player's page waits between signals: the aboard Players' pages together send about 5 a second. */
export const signalIntervalMs = (aboard: number): number => Math.max(MIN_SIGNAL_MS, Math.round((Math.max(1, aboard) * 1000) / SIGNALS_PER_SEC));

export type RideStep =
  | { kind: "wait" }
  /** Boarding: the departure time came (or the car is full); send `check_departure`. */
  | { kind: "depart" }
  /** The Table's previous car is over but core has not frozen it: `finalize` that car first. */
  | { kind: "finalize-previous"; carNo: bigint }
  | { kind: "start-ride" }
  /** The ride (or the draw) runs: keep signalling. */
  | { kind: "signal" }
  /** The ride is over on the rollup but base has not got it: commit the Table again. */
  | { kind: "commit" }
  | { kind: "finalize" }
  /** Core pays the result: room for the winners, then the chunks. */
  | { kind: "settle" }
  | { kind: "close" }
  | { kind: "done" };

export interface RideFacts {
  /** The Player's car: its number and its Table. */
  mine: { carNo: bigint; table: number };
  /** The car's core Match (null once closed). */
  core: CarView | null;
  /** The Table as the rollup has it (null when unreadable). */
  rollup: TableView | null;
  /** The Table's committed copy on base (null when unread). */
  base: TableView | null;
  /** Core froze the car the Table holds now (its receipt exists). */
  previousFrozen: boolean;
  now: number;
}

/** The next step a page takes for its car, from boarding to the last close. */
export function nextRideStep(f: RideFacts): RideStep {
  const core = f.core;
  if (!core || core.stage === "closed") return { kind: "done" };
  if (core.stage === "boarding") return departureDue(core, f.now) ? { kind: "depart" } : { kind: "wait" };
  if (core.stage === "settling" || core.stage === "refunding") return { kind: "settle" };
  if (core.stage === "paid") return { kind: "close" };
  const t = f.rollup;
  if (!t) return { kind: "wait" };
  if (t.carNo === f.mine.carNo && t.phase !== "idle") {
    if (t.phase === "over") return f.base && f.base.carNo === f.mine.carNo && f.base.phase === "over" ? { kind: "finalize" } : { kind: "commit" };
    return { kind: "signal" };
  }
  if (t.nextCar !== f.mine.carNo) return { kind: "wait" };
  if (t.phase === "idle") return { kind: "start-ride" };
  if (t.phase === "over") return f.previousFrozen ? { kind: "start-ride" } : { kind: "finalize-previous", carNo: t.carNo };
  return { kind: "wait" };
}

/** The Players a ride's result pays send its finish (finalize, chunks, closes): a place, an early refund, or a full refund. */
export function mayFinish(t: TableView, me: PublicKey): boolean {
  const s = t.seats.find((x) => x.account.equals(me));
  if (!s) return false;
  if (t.outcome === "refund") return true;
  return s.refund > 0n || t.places.some((p) => p !== NO_SEAT && p === s.tableSeat);
}
