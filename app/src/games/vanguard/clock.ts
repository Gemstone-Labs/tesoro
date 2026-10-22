import { STATUS, type Battle } from "./decode";
import { CAP_MS, OPENING_GRACE_MS, TIMEOUTS_TO_LOSE } from "./rules";

/** After the deadline passes, wait this long more before asking: the Players' clients and the keeper can race, a spare second costs nothing. */
const MARGIN_MS = 1_000;

/** Changes whenever a turn or a step of a Two-Step Turn begins: the moment the countdown restarts. */
export const turnKey = (b: Battle): string => [b.status, b.turnNo, b.moves, b.turn, b.stepsLeft, b.twoStepActive].join(":");

/** The first turn of the Match, which has the opening grace on top of its clock. */
export const isOpening = (b: Battle): boolean => b.turnNo === 0 && b.moves === 0;

/** How long a turn lasts in this Match (ms): the program stores it in the Battle when the Match is created. */
export const turnMsOf = (b: Battle): number => b.turnSecs * 1000;

/**
 * When the turn ring starts, in this client's clock: the moment it saw the turn begin. The opening turn waits
 * out the opening grace first (the first mover is still loading), so its ring stays full until then.
 */
export const ringStart = (b: Battle, seenAt: number): number => seenAt + (isOpening(b) ? b.openingGraceSecs * 1000 : 0);

/** The get-ready countdown before the first move: 10 real seconds (the chain's opening grace), ticking on the last 3. */
export const START_COUNTDOWN = { from: OPENING_GRACE_MS / 1000, stepMs: 1000, tickAt: 3 } as const;
/** Practice has no chain to load, so its get-ready countdown is shorter (founder pick: 6 seconds). */
export const PRACTICE_COUNTDOWN = { from: 6, stepMs: 1000, tickAt: 3 } as const;

/** Whole seconds of get-ready left on a live Match's opening turn, or null when there is none (picks up after a reload). */
export function getReadyLeft(b: Battle, seenAt: number, nowMs: number): number | null {
  if (b.status !== STATUS.live || !isOpening(b)) return null;
  const left = Math.ceil((ringStart(b, seenAt) - nowMs) / 1000);
  return left > 0 ? left : null;
}

/** How much of the turn is left, from 1 (just began) to 0 (the turn is up). */
export const ringLeft = (b: Battle, seenAt: number, nowMs: number): number => Math.max(0, Math.min(1, (ringStart(b, seenAt) + turnMsOf(b) - nowMs) / turnMsOf(b)));

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
  return nowMs >= ringStart(b, seenAt) + turnMsOf(b) + b.graceSecs * 1000 + MARGIN_MS;
}
