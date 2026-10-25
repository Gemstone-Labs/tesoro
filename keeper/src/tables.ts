import { PublicKey } from "@solana/web3.js";
import { PHASE, SLOT, type Table } from "../../app/src/games/trading-duel/chain.ts";
import { shortKey } from "./env.ts";
import { needsRecommit } from "./recommit.ts";

/**
 * Trading Duel table upkeep: the pure decision (`tableStep`), driven by the table scheduler (`scheduler.ts`, ticket 19t).
 *
 * A table plays Match after Match. The per-Match hook (`duel.ts`) drives a Match from Assignment to settlement; what a table
 * needs between Matches is decided here, per table and independent of any Match: commit, close the seats, reset, free ring
 * slots once tesoro_core froze their Match, give up a table whose Match tesoro_core already refunded.
 */

export interface TableFacts {
  phase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** Rollup seconds since the result (0 while not Over). */
  sinceOver: number;
  /** Ring slots in the Done state, each with whether tesoro_core's receipt for its Match is old enough (60 s) to free it. */
  doneSlots: { index: number; match: string; receiptOld: boolean }[];
  /** The Match on the table was refunded by tesoro_core (its receipt is old enough) before the table finished it. */
  matchFrozen: boolean;
  /** A Done result in the ring that base's copy does not show, old enough that its commit is probably lost, and the wait since the last try has passed. */
  recommit: boolean;
}

export type TableStep = { do: "commit_table" | "close_seats" | "reset_table" | "release_slot" | "void_table" | "wait"; why: string; slot?: { index: number; match: string } };

/** A finished table waits this long (rollup seconds) before it is reset, the program's `RESET_DELAY_SECS`. */
export const RESET_DELAY_SECS = 30;

/** One step for one table; frees ring slots first (it never blocks a Match), then moves the table along. */
export function tableStep(f: TableFacts): TableStep {
  const free = f.doneSlots.find((s) => s.receiptOld);
  if (free) return { do: "release_slot", why: `tesoro_core froze ${shortKey(new PublicKey(free.match))}`, slot: { index: free.index, match: free.match } };
  if ((f.phase === PHASE.waiting || f.phase === PHASE.live) && f.matchFrozen) return { do: "void_table", why: "tesoro_core already refunded the Match the table is on" };
  if (f.recommit) return { do: "commit_table", why: "a result is in the ring but not on base: its commit was probably lost, repeating it" };
  if (f.phase === PHASE.idle && f.dirty) return { do: "commit_table", why: "a Match that never began was given up (skip_epoch): its refund result is not committed yet" };
  if (f.phase !== PHASE.over) return { do: "wait", why: `table phase ${f.phase}` };
  if (f.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  if (f.seatsOpen) return { do: "close_seats", why: "Match over, Books still open" };
  if (f.sinceOver < RESET_DELAY_SECS) return { do: "wait", why: `reset in ${RESET_DELAY_SECS - f.sinceOver}s` };
  return { do: "reset_table", why: "committed, seats closed" };
}

/** Rollup facts for one table; `receiptAge(match)` is the age in seconds of tesoro_core's settlement receipt, or `null` if there is none. */
export function tableFacts(t: Table, nowS: number, receiptAge: (match: PublicKey) => number | null, base: Table | null = null, lastRecommit = 0): TableFacts {
  const doneSlots = t.ring
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.state === SLOT.done)
    .map(({ s, index }) => ({ index, match: s.tesoroMatch.toBase58(), receiptOld: (receiptAge(s.tesoroMatch) ?? -1) >= 60 }));
  const onMatch = t.phase === PHASE.waiting || t.phase === PHASE.live;
  return {
    phase: t.phase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    sinceOver: t.phase === PHASE.over ? Math.max(0, Math.floor(nowS - t.overAt)) : 0,
    doneSlots,
    matchFrozen: onMatch && (receiptAge(t.tesoroMatch) ?? -1) >= 60,
    recommit: needsRecommit(t, base, nowS, lastRecommit),
  };
}
