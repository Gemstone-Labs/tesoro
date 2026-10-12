import { COLUMNS, NO_PICK, canPick } from "./grid";
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

/** Whether a pick would still be accepted, by the rollup clock. */
export const pickOpen = (duel: Duel, column: number, nowMs: number): boolean => canPick(column, nowMs / 1000 - duel.startsAt);

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
