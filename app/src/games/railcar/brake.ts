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
import type { Tells } from "./tell-state";

/** Brake seats one bind transaction hands on: the page's own seat and the next ones. */
export const BIND_PER_SEND = 5;

/** Table seats this page binds now: its own, then the next ones (wrapping), while not every seat is bound. */
export function bindTargets(t: Pick<TableView, "phase" | "seated" | "brakesBound">, mySeat: number | null, n = BIND_PER_SEND): number[] {
  if (mySeat === null || (t.phase !== "drawing" && t.phase !== "riding") || t.brakesBound >= t.seated) return [];
  return Array.from({ length: Math.min(n, t.seated) }, (_, k) => (mySeat + k) % t.seated);
}

export type BrakeStatus = "waiting" | "sign" | "ready" | "sending" | "on" | "used";

export interface BrakeFacts {
  aboard: boolean;
  /** Every seat of the ride is bound (`Table.brakesBound == seated`). */
  allBound: boolean;
  /** My Brake seat is bound to this ride. */
  myBound: boolean;
  /** This page can sign my ticks (the seat key the seat names). */
  canSign: boolean;
  /** No first wallet transaction is left to make this ride: the seat-key route, or the wallet's early copy landed. */
  walletCopied: boolean;
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
  if (!(f.allBound && f.myBound && f.canSign)) return { status: "waiting", left: 1, activeMs: 0 };
  return { status: f.walletCopied ? "ready" : "sign", left: 1, activeMs: 0 };
}

/** Where this page is with the wallet's early copy this ride. */
export type EarlyCopy = "none" | "asking" | "done" | "declined";

/**
 * The wallet's early copy (founder 2026-11-08). The first rollup transaction a wallet signs makes the rollup copy that wallet
 * in a public transaction under its address. On the wallet route (`brakeRoute`) that would mark the moment of the Brake, so
 * as the ride starts the page sends one wallet-signed `signal` (valid while the draw is asked for and while riding); the
 * copy then says only that this Player rides without a seat key here. Asked once; after a declined prompt only the button
 * asks again (`brakeState` "sign" until it lands).
 */
export const earlyCopyDue = (o: { route: "next-tick" | "wallet" | null; riding: boolean; aboard: boolean; copy: EarlyCopy }): boolean => o.route === "wallet" && o.riding && o.aboard && o.copy === "none";

/** While the ride runs: an aboard Player whose seat is bound ticks (the Brake rides on it); anyone else signals. */
export const pageSend = (f: { aboard: boolean; myBound: boolean; canSign: boolean }): "tick" | "signal" => (f.aboard && f.myBound && f.canSign ? "tick" : "signal");

/** A screw (false or real, they sound alike), the bolt and panel rattle, the sparks and creak. */
export type TellCue = "screws" | "rattle" | "sparks";

/** Vibration pattern per Tell (ms on, off, on...): stronger as the wall nears. */
export const TELL_HAPTICS: Record<TellCue, number[]> = { screws: [18], rattle: [26, 40, 26], sparks: [40, 30, 40, 30, 60] };

/** What changed between two reads of the public Tells: each new screw and each Tell newly shown, once, in order. */
export function tellCues(prev: Tells | null, next: Tells): TellCue[] {
  if (!prev) return [];
  const out: TellCue[] = [];
  for (let k = prev.screws; k < next.screws; k++) out.push("screws");
  if (next.panel && !prev.panel) out.push("rattle");
  if (next.sparks && !prev.sparks) out.push("sparks");
  return out;
}
