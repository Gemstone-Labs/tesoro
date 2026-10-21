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
  /** Gemas the pack promises: the Lock is sized so the Advance issues exactly this many (one more at most). */
  gemas: number;
}

/**
 * The fewest lamports whose Advance issues `gemas`, with headroom: the Advance is taken at the on-chain price when the
 * transaction lands, and a small tick down between sizing and landing must not floor it to one Gema less. The headroom is
 * half a Gema or 0.035% of the Gemas, whichever is more (under one Gema for every pack, so it never issues two extra).
 */
export function lamportsForGemas(gemas: bigint, m: PackMarket, months: number = PACK_MONTHS): bigint {
  const issued = (lamports: bigint) => quoteNativeAdvance(lamports, m.apyBps, months, m.priceMicroUsd, m.yieldFeeBps).gemas;
  // Thousandths of a Gema to size for.
  const milli = gemas * 1_000n + (gemas * 35n > 50_000n ? (gemas * 35n) / 100n : 500n);
  // gemas = lamports * apy * months * (1 - fee) / (BPS * BPS * 12) * price / 1e13, solved for lamports and rounded up.
  const num = milli * 10n ** 13n * 10_000n * 10_000n * 12n;
  const den = 1_000n * m.priceMicroUsd * BigInt(m.apyBps) * BigInt(months) * BigInt(10_000 - m.yieldFeeBps);
  if (den <= 0n) return 0n;
  let lamports = (num + den - 1n) / den;
  // The two floors inside the Advance can still leave it short of the whole number: step up until it isn't.
  while (issued(lamports) < gemas) lamports += lamports / 1_000_000n + 1n;
  return lamports;
}

/**
 * A pack's Gemas: the whole number its dollars are worth at 12 months of yield net of the Yield Fee, and the Lock that
 * issues exactly that. When the dollars fall a little short of that Lock, Tesoro covers the dust (cents) at the deposit.
 */
export function quotePack(pack: DepositPack, m: PackMarket, checkoutFeeBps: number): PackQuote {
  const feeUsd = (pack.usd * checkoutFeeBps) / 10_000;
  const usd = pack.usd - feeUsd;
  const gemas = Math.round((usd * m.apyBps * (10_000 - m.yieldFeeBps) * PACK_MONTHS) / 12 / 10_000 / 10_000 / 0.01);
  return { pack, lockLamports: lamportsForGemas(BigInt(gemas), m), feeUsd, gemas };
}

/** The pack to highlight for a Player sent from a game: the smallest that covers what they're short, else the largest. */
export function packFor(shortGemas: number, quotes: readonly PackQuote[]): DepositPackId | null {
  if (shortGemas <= 0 || quotes.length === 0) return null;
  return (quotes.find((q) => q.gemas >= shortGemas) ?? quotes[quotes.length - 1]).pack.id;
}
