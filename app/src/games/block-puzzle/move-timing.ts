/**
 * Per-move timing of a Block Burst Board, for bot review (ADR 0012).
 *
 * The program records, for each logged move, the Clock slots between `begin_run` and the
 * transaction that carried it. Moves are sent in batches (up to MAX_PLAY_BATCH per transaction),
 * so every move of a batch shares one offset: read the cadence of batches, not of single moves.
 * Boards created before this field existed do not decode at all.
 */
export interface MoveTiming {
  /** Index in the move log. */
  index: number;
  /** Slots from the run's start to the transaction that carried the move. */
  slots: number;
}

export interface BoardTiming {
  startSlot: bigint;
  moves: MoveTiming[];
}

const toBig = (n: { toString(): string } | number | bigint) => BigInt(n.toString());

/** Reads the timing out of an Anchor-decoded `board` account (`startSlot`, `moves`, `moveSlots`). */
export function boardTiming(board: { startSlot: { toString(): string }; moves: number; moveSlots: ArrayLike<number> }): BoardTiming {
  const count = Math.min(Number(board.moves), board.moveSlots.length);
  const moves: MoveTiming[] = [];
  for (let index = 0; index < count; index++) moves.push({ index, slots: Number(board.moveSlots[index]) });
  return { startSlot: toBig(board.startSlot), moves };
}

/** Distinct batches in order: consecutive moves sharing one offset are one transaction. */
export function batchOffsets(timing: BoardTiming): { slots: number; moves: number }[] {
  const out: { slots: number; moves: number }[] = [];
  for (const m of timing.moves) {
    const last = out[out.length - 1];
    if (last && last.slots === m.slots) last.moves++;
    else out.push({ slots: m.slots, moves: 1 });
  }
  return out;
}
