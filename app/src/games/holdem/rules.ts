import { PHASE, STATUS, type Table } from "./chain";

export interface Legal {
  /** Chips to call, capped at the stack (a short call is all-in). */
  toCall: bigint;
  canRaise: boolean;
  /** Smallest legal raise-to (the whole stack when that is less than a full raise). */
  minTo: bigint;
  /** All-in as a raise-to: bet plus stack. */
  maxTo: bigint;
  /** Nothing bet yet this street: the raise is a bet. */
  isBet: boolean;
}

/** What the Player to act may do, from the public table (mirrors `apply` in programs/holdem/src/engine.rs). */
export function legalMoves(t: Pick<Table, "bets" | "stacks" | "lastRaise">, seat: number): Legal {
  const opp = 1 - seat;
  const current = t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1];
  const maxTo = t.bets[seat] + t.stacks[seat];
  const need = current - t.bets[seat];
  const toCall = need > t.stacks[seat] ? t.stacks[seat] : need;
  // No raising against an all-in opponent, and a raise must exceed the current bet.
  const canRaise = t.stacks[opp] > 0n && maxTo > current;
  const min = current + t.lastRaise;
  return { toCall, canRaise, minTo: min > maxTo ? maxTo : min, maxTo, isBet: current === 0n };
}

/** The only raise sizes the app offers: chips added on top of the current bet. All-in is offered beside them. */
export const RAISE_BY = [200n, 400n, 600n, 800n];

export interface RaisePreset {
  by: bigint;
  /** The raise-to sent on chain: current bet plus `by`. */
  to: bigint;
  /** Legal now: at least a full raise (or exactly all-in) and within the stack. */
  ok: boolean;
}

export function raisePresets(t: Pick<Table, "bets" | "stacks" | "lastRaise">, seat: number): RaisePreset[] {
  const lg = legalMoves(t, seat);
  const current = t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1];
  return RAISE_BY.map((by) => {
    const to = current + by;
    return { by, to, ok: lg.canRaise && to >= lg.minTo && to <= lg.maxTo };
  });
}

/** A hand is being played: dealt, betting not over, Match live. */
export const inPlay = (t: Pick<Table, "status" | "phase">) =>
  t.status === STATUS.live && t.phase >= PHASE.preflop && t.phase <= PHASE.river;
