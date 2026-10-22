/** The most Gemas a Player can pick, never below 0 or above what there is. */
export const clampPick = (picked: number, max: number) => (Number.isFinite(picked) ? Math.max(0, Math.min(Math.floor(picked), max)) : 0);

/**
 * Splits a chosen total of Gemas over the lines in the order they are listed (the program's fast-first order): whole lines
 * first, a part of the line where the total runs out, nothing from the rest.
 */
export function allocate(lines: { gemas: number }[], total: number): number[] {
  let left = clampPick(total, lines.reduce((s, l) => s + l.gemas, 0));
  return lines.map((l) => {
    const take = Math.min(l.gemas, left);
    left -= take;
    return take;
  });
}

/** A line's payout when only `part` of its `gemas` are taken (payouts grow in step with Gemas). */
export const scaled = (amount: number | null, gemas: number, part: number) => (amount === null ? null : gemas > 0 ? (amount * part) / gemas : 0);
