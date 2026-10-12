/** The table's tempo: every Hold'em timing is a base value times PACE, so the whole table speeds up or slows down together. */
export const PACE = 1.7;
export const paced = (ms: number) => Math.round(ms * PACE);
