import { REASON } from "./live-chain";

export type Outcome = "won" | "lost" | "draw" | "refunded";

/** Under every Queue Match you open, and on the waiting card. */
export const QUEUE_SIT_LINE = "You sit first and the Match starts when someone joins.";
export const QUEUE_STAY_LINE = "Stay on this page: leaving after you’re paired loses the Match.";

/**
 * The line under the result: why the Match ended the way it did. `reason` is the table's `REASON`; a Match whose reason
 * is no longer readable (its table moved on) says nothing but the outcome.
 */
export function resultLine(reason: number | null, outcome: Outcome): string | null {
  switch (reason) {
    case REASON.absent:
      return outcome === "won" ? "Your opponent didn’t show up." : "You didn’t check in in time.";
    case REASON.neither:
      return "Nobody checked in in time. Both entries are back.";
    case REASON.noSeed:
      return "The pieces never arrived. Both entries are back.";
    case REASON.void:
      return "The game server stopped during the Match. Both entries are back.";
    case REASON.noShow:
      return "Both of you were here but nobody played, so the Match didn’t count.";
    case REASON.trivial:
      return "Equal scores with under 5 moves each don’t count as a game.";
    case REASON.draw:
      return "Equal scores: both entries are back.";
    default:
      return null;
  }
}

/** While there is no table yet: where the entry is safe, and until when. */
export const needTableLine = (refundBy: string) => `We’re finding you a table. If none starts, your entry comes back by ${refundBy}.`;

/** The Match is waiting for the clock after your run ended early. */
export const WAIT_CLOCK_LINE = "Your run is over. Waiting for the clock.";

/** A second tab is already playing this Match for you. */
export const ELSEWHERE_LINE = "This Match is being played in another tab.";
