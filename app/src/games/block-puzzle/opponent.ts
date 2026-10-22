import { FREEZE_OFFSET_SLOTS, REASON, TABLE_PHASE, phaseAt, type Table } from "./live-chain";

/** What the opponent strip says. `score` and `moves` are the last ones the opponent's page wrote to the public table. */
export type StripState =
  | { kind: "table" }
  | { kind: "checkIn"; theyAreIn: boolean }
  | { kind: "seed" }
  | { kind: "getReady" }
  | { kind: "live"; score: number; moves: number }
  /** From 80 s the last 10 s are hidden for both Players. */
  | { kind: "hidden" }
  /** Your run is over before the clock: the strip waits for it. */
  | { kind: "clock" }
  /** Their seat is empty: they never checked in. */
  | { kind: "gone" }
  /** The Match is over: the final scores. */
  | { kind: "final"; score: number; moves: number };

export interface StripInput {
  /** `null` while there is no table to read (no Assignment yet, or the read failed). */
  table: Table | null;
  /** Whether an Assignment exists (a table has been chosen for this Match). */
  assigned: boolean;
  slot: number;
  seat: 0 | 1;
  /** Your own run is over (stuck or out of moves) before the clock. */
  ownOver: boolean;
}

export function stripOf(i: StripInput): StripState {
  const t = i.table;
  if (!i.assigned || !t) return { kind: "table" };
  const opp = (1 - i.seat) as 0 | 1;
  if (t.phase === TABLE_PHASE.closed) {
    // A Match that ended in the check-in window has no scores: the absent side is "gone".
    if (t.reason === REASON.absent && !t.checkedIn[opp]) return { kind: "gone" };
    return { kind: "final", score: t.finalScores[opp], moves: t.finalMoves[opp] };
  }
  const phase = phaseAt(t, i.slot);
  if (phase === "checkIn") return { kind: "checkIn", theyAreIn: t.checkedIn[opp] };
  if (phase === "ended" && !t.checkedIn[opp] && t.phase === TABLE_PHASE.assigned) return { kind: "gone" };
  if (phase === "seeding") return { kind: "seed" };
  if (phase === "getReady") return { kind: "getReady" };
  if (i.ownOver && phase !== "ended") return { kind: "clock" };
  if (i.slot >= t.startSlot + FREEZE_OFFSET_SLOTS) return { kind: "hidden" };
  return { kind: "live", score: t.shownScore[opp], moves: t.shownMoves[opp] };
}

/** One line for the strip. */
export function stripLine(s: StripState): string {
  switch (s.kind) {
    case "table":
      return "Waiting for a table";
    case "checkIn":
      return s.theyAreIn ? "Opponent is here" : "Waiting for your opponent to check in";
    case "seed":
      return "Dealing the pieces";
    case "getReady":
      return "Get ready";
    case "live":
      return `${s.score.toLocaleString("en-US")} · ${s.moves} ${s.moves === 1 ? "move" : "moves"}`;
    case "hidden":
      return "?";
    case "clock":
      return "Waiting for the clock";
    case "gone":
      return "Your opponent didn’t show up";
    case "final":
      return `${s.score.toLocaleString("en-US")} · ${s.moves} ${s.moves === 1 ? "move" : "moves"}`;
  }
}
