import { SIDE } from "../chain";
import { equity, openProblem, type Ledger } from "../math";

/** Deterministic generator (mulberry32) so tests and replays can fix the bot's choices. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BotMove = { kind: "open"; side: 1 | 2; margin: bigint; leverage: number } | { kind: "close" } | null;

export const BOT_MAX_LEVERAGE = 6;
const LOOKBACK = 15;

/** Momentum in units of the recent per-step volatility; positive when the price has been rising. */
export function trend(prices: number[]): number {
  const w = prices.slice(-LOOKBACK);
  if (w.length < 6) return 0;
  const net = (w[w.length - 1] - w[0]) / w[0];
  let abs = 0;
  for (let i = 1; i < w.length; i++) abs += Math.abs(w[i] - w[i - 1]) / w[i - 1];
  const vol = abs / (w.length - 1);
  return net / (vol * Math.sqrt(w.length - 1) + 1e-9);
}

/**
 * A simple trend follower: opens with the trend when it is clear, a modest size and at most 6x,
 * and closes on a profit target, a stop, or a reversal. It sees only the public price and its own
 * Book, like a Player.
 */
export function botDecide(ledger: Ledger, prices: number[], mid: bigint, rng: () => number): BotMove {
  const z = trend(prices);
  if (ledger.side === SIDE.flat) {
    if (Math.abs(z) < 1.2 || rng() > 0.4) return null;
    const side = z > 0 ? SIDE.long : SIDE.short;
    const leverage = 2 + Math.floor(rng() * (BOT_MAX_LEVERAGE - 1));
    const share = 0.15 + rng() * 0.2;
    const margin = BigInt(Math.max(100, Math.floor((Number(ledger.cash) * share) / 50) * 50));
    if (openProblem(ledger, margin, leverage)) return null;
    return { kind: "open", side: side as 1 | 2, margin, leverage };
  }
  const gain = Number(equity(ledger, mid) - ledger.cash - ledger.margin) / Number(ledger.margin);
  const against = (ledger.side === SIDE.long && z < -1) || (ledger.side === SIDE.short && z > 1);
  if (gain > 0.08 || gain < -0.06 || against || rng() < 0.03) return { kind: "close" };
  return null;
}
