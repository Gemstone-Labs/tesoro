import { CLUSTER } from "@/lib/cluster-settings";
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
}

export function packMarket(market: NativeMarket | null | undefined, nowSec: number = Math.floor(Date.now() / 1000)): PackMarket | null {
  if (!market?.price) return null;
  if (nowSec - market.price.updatedTs > MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS) return null;
  const apyBps = CLUSTER.yieldModel === "real" ? (market.stake?.open ? market.stake.sizingBps : 0) : market.pool.apyBps;
  if (apyBps <= 0) return null;
  return { priceMicroUsd: market.price.microUsd, apyBps };
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
  /** Gemas the pack promises: the Lock is sized so the Advance issues exactly this many, and the Advance carries them as its floor. */
  gemas: number;
}

/**
 * The fewest lamports whose Advance issues at least `gemas`. The Advance carries `gemas` as its `min_gemas` floor, so the
 * Lock is sized right on the line: a price move between sizing and landing refuses the Advance (and the caller re-sizes)
 * instead of issuing fewer Gemas.
 */
export function lamportsForGemas(gemas: bigint, m: PackMarket, months: number = PACK_MONTHS): bigint {
  const issued = (lamports: bigint) => quoteNativeAdvance(lamports, m.apyBps, months, m.priceMicroUsd).gemas;
  if (gemas <= 0n || m.priceMicroUsd <= 0n || m.apyBps <= 0 || months <= 0) return 0n;
  // gemas = floor(units * price / 1e13) and units = floor(lamports * apy * months / (12 * BPS)): invert each floor, rounding up.
  const units = (gemas * 10n ** 13n + m.priceMicroUsd - 1n) / m.priceMicroUsd;
  const per = BigInt(m.apyBps) * BigInt(months);
  let lamports = (units * 12n * 10_000n + per - 1n) / per;
  while (issued(lamports) < gemas) lamports += 1n;
  return lamports;
}

/**
 * A pack's Gemas: the whole number its dollars are worth at 12 months of yield, and the Lock that issues exactly that.
 * When the dollars fall a little short of that Lock, Tesoro covers the dust (cents) at the deposit.
 */
export function quotePack(pack: DepositPack, m: PackMarket, checkoutFeeBps: number): PackQuote {
  const feeUsd = (pack.usd * checkoutFeeBps) / 10_000;
  const usd = pack.usd - feeUsd;
  const gemas = Math.round((usd * m.apyBps * PACK_MONTHS) / 12 / 10_000 / 0.01);
  return { pack, lockLamports: lamportsForGemas(BigInt(gemas), m), feeUsd, gemas };
}

/** The pack to highlight for a Player sent from a game: the smallest that covers what they're short, else the largest. */
export function packFor(shortGemas: number, quotes: readonly PackQuote[]): DepositPackId | null {
  if (shortGemas <= 0 || quotes.length === 0) return null;
  return (quotes.find((q) => q.gemas >= shortGemas) ?? quotes[quotes.length - 1]).pack.id;
}
