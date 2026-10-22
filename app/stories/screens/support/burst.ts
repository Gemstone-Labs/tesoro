import type { BurstView } from "@/games/block-puzzle/useBurstMatch";
import type { MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { REASON, SLOTS_PER_SEC, TABLE_PHASE, type Table } from "@/games/block-puzzle/live-chain";
import { runRemainingMs, type SlotClock } from "@/games/block-puzzle/live-clock";
import type { ChainMatch } from "@/lib/chain/read";

import { ASSIGNED, blankTable, fixtureAssignment as assignment } from "@/games/block-puzzle/live-fixtures";
const SECS = SLOTS_PER_SEC;

/** The rollup's clock, frozen at `slot` (-1 in `at` makes the mock start it at mount; a story that plays lets it run). */
const clockAt = (slot: number, run = false): SlotClock => ({ slot, at: -1, rate: run ? SECS / 1000 : 0 });

/** A table in each stage of a Match, measured in seconds from its assignment. `t` is the seconds since the run's start slot. */
type Kind = "table" | "checkIn" | "checkedIn" | "seeding" | "getReady" | "playing" | "last10" | "waitClock" | "opponentGone" | "reconnect" | "elsewhere" | "closing";

const START = ASSIGNED + 70 * SECS;

export function burstView(kind: Kind, m?: ChainMatch): Partial<BurstView> {
  const seat = m?.seat ?? 0;
  const base = { seat, assignment: assignment(), match: m ?? null };
  const seated = { seatsOpen: true } as const;
  switch (kind) {
    case "table":
      return { stage: "table", seat, match: m ?? null };
    case "checkIn":
      return { ...base, stage: "setup", table: blankTable({ phase: TABLE_PHASE.assigned, ...seated }), clock: clockAt(ASSIGNED + 12 * SECS) };
    case "checkedIn":
      return { ...base, stage: "setup", table: blankTable({ phase: TABLE_PHASE.assigned, ...seated, checkedIn: seat === 0 ? [true, false] : [false, true] }), clock: clockAt(ASSIGNED + 31 * SECS) };
    case "seeding":
      return { ...base, stage: "setup", table: blankTable({ phase: TABLE_PHASE.seeding, ...seated, checkedIn: [true, true], seedingSlot: ASSIGNED + 20 * SECS, reqPending: true, reqCount: 1, reqSlot: ASSIGNED + 21 * SECS }), clock: clockAt(ASSIGNED + 25 * SECS) };
    case "getReady":
      return { ...base, stage: "getReady", table: blankTable({ phase: TABLE_PHASE.getReady, ...seated, checkedIn: [true, true], seedReady: true, startSlot: START }), clock: clockAt(START - 7 * SECS) };
    case "playing":
    case "last10":
    case "waitClock":
    case "elsewhere":
    case "reconnect": {
      const t = kind === "last10" ? 84 : 31;
      const table = blankTable({
        phase: TABLE_PHASE.getReady,
        ...seated,
        checkedIn: [true, true],
        seedReady: true,
        startSlot: START,
        shownScore: [120, 104],
        shownMoves: [11, 9],
      });
      const clock = clockAt(START + t * SECS, kind === "playing");
      return { ...base, stage: "playing", table, clock, ownOver: kind === "waitClock", reconnecting: kind === "reconnect", elsewhere: kind === "elsewhere", run: kind === "elsewhere" ? null : run(table, clock) };
    }
    case "opponentGone":
      return {
        ...base,
        stage: "closing",
        table: blankTable({ phase: TABLE_PHASE.closed, ...seated, checkedIn: seat === 0 ? [true, false] : [false, true], reason: REASON.absent, dirty: true }),
        clock: clockAt(ASSIGNED + 61 * SECS),
        reason: REASON.absent,
      };
    case "closing":
      return { ...base, stage: "closing", table: blankTable({ phase: TABLE_PHASE.closed, ...seated, checkedIn: [true, true], reason: REASON.played, dirty: true, finalScores: [212, 187], finalMoves: [24, 21] }), clock: clockAt(START + 95 * SECS), reason: REASON.played };
  }
}

/** A run on the table's clock, for the play screens. The Seed is made up and nothing is sent. */
function run(table: Table, clock: SlotClock): MatchRun {
  let at = -1;
  return {
    seed: 0x5eed1234abcdn,
    entry: 1000,
    remainingMs: () => {
      if (at < 0) at = performance.now();
      return runRemainingMs(table, { ...clock, at }, performance.now());
    },
    onMove: () => undefined,
    onEnd: () => undefined,
  };
}
