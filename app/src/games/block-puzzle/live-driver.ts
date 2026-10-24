import type { Assignment, OwnBoard, Table } from "./live-chain";
import { atAssignedEpoch } from "../../lib/chain/table-epoch";
import { MAX_SEED_REQUESTS, SEED_RETRY_SLOTS, SEED_SLOTS, TABLE_PHASE, canFinalizeTable, phaseAt, tableOf } from "./live-chain";

/**
 * How long a table has to stay in the same state before this Player's page does a step anyone may do (the keeper does them
 * first; this is what keeps a Match moving when it is down). The opener waits a little longer, so the two pages do not send
 * the same step at once; a lost race is harmless because every step re-reads the table.
 */
export const STEP_IN_MS = 6_000;
export const OPENER_EXTRA_MS = 2_000;

/** What the driver does next. `run` means the Player is playing: the submitter owns the moves. */
export type Step =
  | { kind: "wait"; why: "table" | "setup" | "opponent" | "seed" | "clock" | "result" | "payout" | "elsewhere" }
  | { kind: "beginMatch" }
  | { kind: "seatPlayers" }
  | { kind: "checkIn" }
  | { kind: "requestSeed" }
  | { kind: "start" }
  | { kind: "begin" }
  | { kind: "run" }
  | { kind: "close" }
  | { kind: "commitTable" }
  | { kind: "finalize" }
  | { kind: "done" };

export interface DriveInput {
  seat: 0 | 1;
  /** tesoro_core's view of the Match. */
  status: "open" | "active" | "settled" | "refunded";
  assignment: Assignment | null;
  /** The table in the rollup, `null` when it cannot be read. */
  table: Table | null;
  /** The table as the base layer last saw it, read only once the result is in; `null` before. */
  baseTable: Table | null;
  /** The rollup slot now, from the page's clock. */
  slot: number;
  /** Unix seconds (compared with the Assignment's wall-clock start deadline only). */
  nowS: number;
  /** The Player's own Board; `null` before they were seated and when it cannot be read. */
  board: OwnBoard | null;
  /** How long the table has been in this state as this page sees it. */
  stalledMs: number;
}

/** True once this page should do a step anyone may do. */
export const steppedIn = (i: Pick<DriveInput, "seat" | "stalledMs">): boolean => i.stalledMs >= STEP_IN_MS + (i.seat === 0 ? OPENER_EXTRA_MS : 0);

/**
 * The one step this page takes next, from what it has read. Pure: no reads, no sends. Steps anyone may do (`beginMatch`,
 * `seatPlayers`, `requestSeed`, `start`, `close`, `commitTable`, `finalize`) wait for `steppedIn`, so the keeper normally
 * does them; the Player's own steps (`checkIn`, `begin`) go at once.
 */
export function nextStep(i: DriveInput): Step {
  if (i.status === "settled" || i.status === "refunded") return { kind: "done" };
  if (i.status === "open") return { kind: "wait", why: "opponent" };
  const a = i.assignment;
  if (!a) return { kind: "wait", why: "table" };
  const t = i.table;
  if (!t) return { kind: "wait", why: "setup" };
  const late = steppedIn(i);

  // The table moved on to another Match: this Match's result is in the committed ring.
  if (!tableOf(a, t) && !(t.phase === TABLE_PHASE.idle && atAssignedEpoch(a, t))) return i.baseTable && canFinalizeTable(i.baseTable, a, i.nowS) && late ? { kind: "finalize" } : { kind: "wait", why: "payout" };

  const phase = phaseAt(t, i.slot);
  switch (t.phase) {
    case TABLE_PHASE.idle:
      // Never begun: only inside the start window (after it, tesoro_core refunds at its deadline).
      return late && i.nowS <= a.startDeadline ? { kind: "beginMatch" } : { kind: "wait", why: "setup" };
    case TABLE_PHASE.closed: {
      if (t.dirty) return late ? { kind: "commitTable" } : { kind: "wait", why: "result" };
      return i.baseTable && canFinalizeTable(i.baseTable, a, i.nowS) && late ? { kind: "finalize" } : { kind: "wait", why: "payout" };
    }
  }

  if (phase === "ended") return late ? { kind: "close" } : { kind: "wait", why: "result" };

  if (t.phase === TABLE_PHASE.assigned) {
    if (!t.seatsOpen) return late ? { kind: "seatPlayers" } : { kind: "wait", why: "setup" };
    if (!t.checkedIn[i.seat]) return { kind: "checkIn" };
    return { kind: "wait", why: "opponent" };
  }

  if (t.phase === TABLE_PHASE.seeding) {
    if (!t.seedReady) {
      const due = !t.reqPending || (i.slot - t.reqSlot >= SEED_RETRY_SLOTS && t.reqCount < MAX_SEED_REQUESTS);
      return late && due && i.slot - t.seedingSlot < SEED_SLOTS ? { kind: "requestSeed" } : { kind: "wait", why: "seed" };
    }
    if (!t.startSlot) return late ? { kind: "start" } : { kind: "wait", why: "seed" };
  }

  // getReady: the run is on the clock from `start_slot`.
  if (phase === "getReady") return { kind: "wait", why: "clock" };
  if (!i.board) return { kind: "wait", why: "setup" };
  if (!i.board.began) return { kind: "begin" };
  return { kind: "run" };
}
