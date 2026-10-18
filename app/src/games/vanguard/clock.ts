import { STATUS, type Battle } from "./decode";
import { CAP_MS, CHAIN_CLOCK, TIMEOUTS_TO_LOSE, TURN_MS } from "./rules";

/** After the deadline passes, wait this long more before asking: the Players' clients and the keeper can race, a spare second costs nothing. */
const MARGIN_MS = 1_000;

/** Changes whenever a turn or a step of a Two-Step Turn begins: the moment the countdown restarts. */
export const turnKey = (b: Battle): string => [b.status, b.turnNo, b.moves, b.turn, b.stepsLeft, b.twoStepActive].join(":");

/** The first turn of the Match, which has the opening grace on top of its clock. */
const isOpening = (b: Battle): boolean => b.turnNo === 0 && b.moves === 0;

/**
 * When the 5 second ring starts, in this client's clock: the moment it saw the turn begin. The opening turn waits
 * out the opening grace first (the first mover is still loading), so its ring stays full until then.
 */
export const ringStart = (b: Battle, seenAt: number): number => seenAt + (isOpening(b) ? CHAIN_CLOCK.openingGraceMs : 0);

/** How much of the turn is left, from 1 (just began) to 0 (the 5 seconds are up). */
export const ringLeft = (b: Battle, seenAt: number, nowMs: number): number => Math.max(0, Math.min(1, (ringStart(b, seenAt) + TURN_MS - nowMs) / TURN_MS));

/** "Missed 1 of 3" for a side that has let its clock run out in a row; null when it has not. */
export const missedLabel = (missed: number): string | null => (missed > 0 ? `Missed ${Math.min(missed, TIMEOUTS_TO_LOSE)} of ${TIMEOUTS_TO_LOSE}` : null);

/**
 * Whether this client should ask the program for a timeout now. The browser's clock is not the rollup's, so the
 * turn is timed from when this client first saw it (`seenAt`), which can only be later than the rollup's start:
 * an early ask is refused harmlessly, a late one is covered by the keeper.
 */
export function claimDue(b: Battle, seenAt: number, nowMs: number): boolean {
  if (b.status === STATUS.created || b.status === STATUS.setup) {
    const start = b.startDeadline * 1000 + MARGIN_MS * 2;
    const entropy = b.entropyDeadline > 0 ? b.entropyDeadline * 1000 + MARGIN_MS * 2 : Infinity;
    return nowMs >= Math.min(start, entropy);
  }
  if (b.status !== STATUS.live) return false;
  if (nowMs >= b.startedAt * 1000 + CAP_MS + MARGIN_MS * 2) return true;
  return nowMs >= ringStart(b, seenAt) + CHAIN_CLOCK.turnMs + CHAIN_CLOCK.graceMs + MARGIN_MS;
}
