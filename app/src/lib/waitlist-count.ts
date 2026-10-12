/** The waitlist shows its size only from this many players: a small number reads as an empty room. */
export const SHOW_COUNT_FROM = 100;

/** "1,200+ players waiting", rounded down to a 100 (a 1,000 from 10,000), or null below the threshold. */
export function waitingLabel(n: number | null): string | null {
  if (n === null || n < SHOW_COUNT_FROM) return null;
  const step = n < 10_000 ? 100 : 1_000;
  return `${(Math.floor(n / step) * step).toLocaleString("en-US")}+ players waiting`;
}
