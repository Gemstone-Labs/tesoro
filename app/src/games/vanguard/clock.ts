import { STATUS, type Battle } from "./decode";
import { CAP_MS, CHAIN_CLOCK } from "./rules";

/** After the deadline passes, wait this long more before asking: the Players' clients and the keeper can race, a spare second costs nothing. */
const MARGIN_MS = 1_000;

/** Changes whenever a turn or a step of a Two-Step Turn begins: the moment the countdown restarts. */
export const turnKey = (b: Battle): string => [b.status, b.turnNo, b.moves, b.turn, b.stepsLeft, b.twoStepActive].join(":");

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
  return nowMs >= seenAt + CHAIN_CLOCK.turnMs + CHAIN_CLOCK.graceMs + MARGIN_MS;
}
