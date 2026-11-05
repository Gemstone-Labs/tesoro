/**
 * The secret Brake and the Tells on a Player's page, pure. Design: `.scratch/railcar/07-brake-decision.md`.
 *
 * - While the draw is asked for, pages bind every seat's Brake seat (`bind_brake`, anyone, a repeat does nothing), so a
 *   binding never marks a Player who means to Brake. No Brake counts until every seat is bound.
 * - An aboard Player's page sends `tick` instead of `signal`, signed by the seat key; a Brake is the next tick's flag,
 *   never a transaction of its own. Only that Player's screen shows it.
 */
import { BRAKE_MS } from "./engine";
import type { TableView } from "./chain";

/** Brake seats one bind transaction hands on: the page's own seat and the next ones. */
export const BIND_PER_SEND = 5;

/** Table seats this page binds now: its own, then the next ones (wrapping), while not every seat is bound. */
export function bindTargets(t: Pick<TableView, "phase" | "seated" | "brakesBound">, mySeat: number | null, n = BIND_PER_SEND): number[] {
  if (mySeat === null || (t.phase !== "drawing" && t.phase !== "riding") || t.brakesBound >= t.seated) return [];
  return Array.from({ length: Math.min(n, t.seated) }, (_, k) => (mySeat + k) % t.seated);
}

export type BrakeStatus = "waiting" | "ready" | "sending" | "on" | "used";

export interface BrakeFacts {
  aboard: boolean;
  /** Every seat of the ride is bound (`Table.brakesBound == seated`). */
  allBound: boolean;
  /** My Brake seat is bound to this ride. */
  myBound: boolean;
  /** This page can sign my ticks (the seat key the seat names). */
  canSign: boolean;
  /** Ride ms of my Brake, from my own Brake seat (or this page's memory of it); null before I Brake. */
  pressMs: number | null;
  /** Pressed here, waiting for the next tick to carry it. */
  pending: boolean;
  rideMs: number;
}

export interface BrakeState {
  status: BrakeStatus;
  /** Brakes left this ride (1 or 0). */
  left: number;
  /** Ms left of my own slow period: what my screen shows. Another Player's Brake never shows here. */
  activeMs: number;
}

/** My Brake on my screen; null off the car. */
export function brakeState(f: BrakeFacts): BrakeState | null {
  if (!f.aboard) return null;
  if (f.pressMs !== null) {
    const activeMs = Math.max(0, f.pressMs + BRAKE_MS - f.rideMs);
    return { status: activeMs > 0 ? "on" : "used", left: 0, activeMs };
  }
  if (f.pending) return { status: "sending", left: 0, activeMs: 0 };
  return { status: f.allBound && f.myBound && f.canSign ? "ready" : "waiting", left: 1, activeMs: 0 };
}

/** While the ride runs: an aboard Player whose seat is bound ticks (the Brake rides on it); anyone else signals. */
export const pageSend = (f: { aboard: boolean; myBound: boolean; canSign: boolean }): "tick" | "signal" => (f.aboard && f.myBound && f.canSign ? "tick" : "signal");

/** Screws (also each false screw), bolt and panel rattle, sparks and creak. */
export type TellCue = "screws" | "rattle" | "sparks";
const STAGE_CUES: TellCue[] = ["screws", "rattle", "sparks"];

/** Vibration pattern per Tell (ms on, off, on...): stronger as the wall nears. */
export const TELL_HAPTICS: Record<TellCue, number[]> = { screws: [18], rattle: [26, 40, 26], sparks: [40, 30, 40, 30, 60] };

type Tells = Pick<TableView, "tell" | "falseScrews">;

/** What changed between two reads of the public Tells: each new stage and each new false screw, once, in order. */
export function tellCues(prev: Tells | null, next: Tells): TellCue[] {
  if (!prev) return [];
  const out: TellCue[] = [];
  for (let k = prev.falseScrews; k < next.falseScrews; k++) out.push("screws");
  for (let s = prev.tell; s < next.tell; s++) out.push(STAGE_CUES[s] ?? "sparks");
  return out;
}
