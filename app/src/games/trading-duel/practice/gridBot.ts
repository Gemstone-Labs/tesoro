import { bandOf, lockAt } from "../grid";

const LOOKBACK = 20;
/** How far the bot trusts the recent drift, and how wide its guess scatters, in units of the recent volatility. */
export const DRIFT_TRUST = 0.35;
export const SCATTER = 0.6;

/** A normal draw from two uniforms. */
const gauss = (rng: () => number) => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());

/**
 * The bot's band for a column that starts `horizonSecs` from now: the last price carried forward by
 * a fraction of the recent drift, plus noise that grows with the horizon. It sees only the public
 * price (USD, one sample per second, newest last), like a Player.
 */
export function botBand(prices: number[], horizonSecs: number, anchor: bigint, step: bigint, rng: () => number): number {
  const w = prices.slice(-LOOKBACK);
  const last = w[w.length - 1];
  if (w.length < 3 || !(last > 0)) return Math.floor(rng() * 2) - 1;
  const drift = (last - w[0]) / (w.length - 1);
  let sq = 0;
  for (let i = 1; i < w.length; i++) sq += (w[i] - w[i - 1]) ** 2;
  const vol = Math.sqrt(sq / (w.length - 1));
  const guess = last + drift * horizonSecs * DRIFT_TRUST + gauss(rng) * vol * Math.sqrt(Math.max(1, horizonSecs)) * SCATTER;
  return bandOf(BigInt(Math.round(guess * 1e8)), anchor, step);
}

/** When the bot makes up its mind about a column: a few seconds to a quarter-minute before it locks. */
export function botPickTimes(rng: () => number): number[] {
  return Array.from({ length: 12 }, (_, c) => Math.max(0, lockAt(c) - 2 - rng() * 13));
}
