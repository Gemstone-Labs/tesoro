import { COLUMNS, NO_PICK } from "./grid";
import { DRAW, STATUS, type Book, type Duel } from "./chain";

/** Rows you picked and the chain has not confirmed yet, by column (`NO_PICK` is a pending clear). */
export type PendingPicks = Readonly<Record<number, number>>;

const blank = (): number[] => Array.from({ length: COLUMNS }, () => NO_PICK);

/**
 * Your picks for the screen: your own Book (private, readable only by you) or, without it, what the
 * Duel revealed of you, with the picks still in flight laid over it.
 */
export function mergePicks(book: Book | null, revealed: number[] | null, pending: PendingPicks): number[] {
  const out = [...(book?.picks ?? revealed ?? blank())];
  for (const [c, row] of Object.entries(pending)) out[Number(c)] = row;
  return out;
}

export function dropPending(pending: PendingPicks, column: number): PendingPicks {
  const out: Record<number, number> = { ...pending };
  delete out[column];
  return out;
}

/** Your pending picks without the ones the Book now shows. */
export function settlePending(pending: PendingPicks, book: Book | null): PendingPicks {
  if (!book) return pending;
  const out: Record<number, number> = {};
  for (const [c, row] of Object.entries(pending)) if (book.picks[Number(c)] !== row) out[Number(c)] = row;
  return out;
}

/** One look at the rollup's clock: the time it stamped on the Duel's last tick (unix seconds) and when this browser read it (ms). */
export interface ClockSighting {
  rollupS: number;
  seenMs: number;
}

/** How many recent sightings count. */
export const CLOCK_WINDOW = 12;
const MAX_OFFSET_MS = 30_000;

/**
 * How far the rollup's clock runs ahead of this browser's (ms; negative when behind): add it to
 * `Date.now()` to get rollup time. A stamp is whole seconds and reaches the browser a little after
 * it was made, so every sighting reads low; the best of the recent ones has the least delay, and
 * half a second is added back for the stamp's lost fraction. Zero without any sighting.
 */
export function clockOffsetMs(sightings: ClockSighting[]): number {
  if (!sightings.length) return 0;
  const best = Math.max(...sightings.map((s) => s.rollupS * 1000 - s.seenMs));
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(best + 500)));
}

/** The recent sightings with a new one; a stamp already seen adds nothing. */
export function addSighting(sightings: ClockSighting[], s: ClockSighting): ClockSighting[] {
  if (sightings.some((x) => x.rollupS === s.rollupS)) return sightings;
  return [...sightings, s].slice(-CLOCK_WINDOW);
}

export interface GridInputs {
  mine: number[];
  theirs: number[];
  final: { you: number; them: number } | null;
}

/** What `GridScreen` shows for one Player, from the Duel, their Book and their unconfirmed picks. */
export function gridInputs(duel: Duel, seat: 0 | 1, book: Book | null, pending: PendingPicks): GridInputs {
  const over = duel.status === STATUS.over;
  return {
    mine: mergePicks(book, duel.revealed[seat], over ? {} : pending),
    theirs: duel.revealed[1 - seat],
    final: over ? { you: duel.scores[seat], them: duel.scores[1 - seat] } : null,
  };
}

/** The end of a Match in words: who won, or that it was a draw. */
export const isDraw = (duel: Duel): boolean => duel.status === STATUS.over && duel.winner === DRAW;

export { canFinalizeTable as canFinalize } from "./chain";
