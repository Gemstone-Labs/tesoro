import { CLUSTER } from "@/lib/cluster-settings";
import { ratesOf } from "@/lib/chain/fees";
import { LAMPORTS, MAX_PRICE_AGE_SECS, PRICE_QUOTE_MARGIN_SECS, quoteNativeAdvance, type NativeMarket } from "@/lib/chain/native";

/** The three deposit packs of the Simple view. Every pack is a SOL Lock with a 12-month Length and its Advance taken at once. */
export type DepositPackId = "starter" | "player" | "pro";
export interface DepositPack {
  id: DepositPackId;
  name: string;
  /** What the Player deposits, US dollars. */
  usd: number;
}

export const DEPOSIT_PACKS: readonly DepositPack[] = [
  { id: "starter", name: "Starter", usd: 100 },
  { id: "player", name: "Player", usd: 250 },
  { id: "pro", name: "Pro", usd: 500 },
];

/** The Length of every pack, months. */
export const PACK_MONTHS = 12;

/** What a pack quote needs from the market, read once. Null when the price is too old to quote on. */
export interface PackMarket {
  priceMicroUsd: bigint;
  /** The APY an Advance is sized on: the test pool's, or the staking token's trailing rate on mainnet. */
  apyBps: number;
  yieldFeeBps: number;
}

export function packMarket(market: NativeMarket | null | undefined, nowSec: number = Math.floor(Date.now() / 1000)): PackMarket | null {
  if (!market?.price) return null;
  if (nowSec - market.price.updatedTs > MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS) return null;
  const apyBps = CLUSTER.yieldModel === "real" ? (market.stake?.open ? market.stake.sizingBps : 0) : market.pool.apyBps;
  if (apyBps <= 0) return null;
  return { priceMicroUsd: market.price.microUsd, apyBps, yieldFeeBps: ratesOf(market.treasury).yieldFeeBps };
}

/** SOL base units worth `usd` at the price. */
export const usdToLamports = (usd: number, priceMicroUsd: bigint): bigint =>
  priceMicroUsd > 0n ? (BigInt(Math.round(usd * 1e6)) * BigInt(LAMPORTS)) / priceMicroUsd : 0n;

export interface PackQuote {
  pack: DepositPack;
  /** The SOL that gets locked: the deposit less the checkout fee, base units. */
  lockLamports: bigint;
  /** The checkout fee, US dollars. */
  feeUsd: number;
  /** Gemas the Advance issues for that Lock. */
  gemas: number;
}

/** A pack's Gemas, exactly as the Advance sizes them: the 12-month projected yield of the Lock, net of the Yield Fee. */
export function quotePack(pack: DepositPack, m: PackMarket, checkoutFeeBps: number): PackQuote {
  const feeUsd = (pack.usd * checkoutFeeBps) / 10_000;
  const usd = pack.usd - feeUsd;
  const gemasFor = (lamports: bigint) => quoteNativeAdvance(lamports, m.apyBps, PACK_MONTHS, m.priceMicroUsd, m.yieldFeeBps).gemas;
  // The dollar-to-SOL step and the Advance both round down, so $100 at 7% lands on 559, not 560. Lock the few extra
  // lamports (a fraction of a cent) that reach the whole number the dollars are worth.
  const target = BigInt(Math.round((usd * m.apyBps * (10_000 - m.yieldFeeBps) * PACK_MONTHS) / 12 / 10_000 / 10_000 / 0.01));
  let lockLamports = usdToLamports(usd, m.priceMicroUsd);
  let gemas = gemasFor(lockLamports);
  if (gemas < target) {
    const step = lockLamports / 100_000n + 1n;
    for (let i = 0; i < 64 && gemas < target; i++) {
      lockLamports += step;
      gemas = gemasFor(lockLamports);
    }
  }
  return { pack, lockLamports, feeUsd, gemas: Number(gemas) };
}

/** The pack to highlight for a Player sent from a game: the smallest that covers what they're short, else the largest. */
export function packFor(shortGemas: number, quotes: readonly PackQuote[]): DepositPackId | null {
  if (shortGemas <= 0 || quotes.length === 0) return null;
  return (quotes.find((q) => q.gemas >= shortGemas) ?? quotes[quotes.length - 1]).pack.id;
}
