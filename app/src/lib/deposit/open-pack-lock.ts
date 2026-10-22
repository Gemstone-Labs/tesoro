import { CLUSTER } from "@/lib/cluster-settings";
import { getChain } from "@/lib/chain/client";
import { fetchNativeMarket, quoteNativeAdvance } from "@/lib/chain/native";
import { openPositionWithAdvance, openStakePositionWithAdvance } from "@/lib/chain/native-flow";
import { simSharesFor, type CheckoutContext } from "./checkout";
import { PACK_MONTHS, lamportsForGemas, packMarket } from "./packs";

export interface PackLockResult {
  positionPubkey: string;
  /** Gemas the Advance issued: the promised number (one more at most). */
  gemas: number;
  signatures: string[];
}

/**
 * The one place the Simple view touches the chain to deposit: opens a SOL Lock with a `months` Length that issues `gemas`,
 * and takes its Advance. The market is read again from the chain first, so the Lock is sized on the price the Advance will
 * use; `fund` tops the wallet up to that Lock (the payment can be a few lamports short). The economy upgrade swaps this
 * function's body; its shape stays.
 */
export async function openPackLock(
  ctx: CheckoutContext,
  { gemas, months = PACK_MONTHS, fund }: { gemas: number; months?: number; fund: (lamports: bigint) => Promise<void> },
): Promise<PackLockResult> {
  const market = await fetchNativeMarket(getChain().base, ctx.signer.publicKey);
  const m = packMarket(market);
  if (!m) throw new Error("The SOL price is updating. Try again in a few minutes.");
  const lamports = lamportsForGemas(BigInt(gemas), m, months);
  await fund(lamports);
  const issued = Number(quoteNativeAdvance(lamports, m.apyBps, months, m.priceMicroUsd, m.yieldFeeBps).gemas);
  const onStep = (s: string) => ctx.onStep?.(s === "Locking your SOL" || s === "Staking and locking your SOL" ? "Adding your deposit" : s);
  const opened =
    CLUSTER.yieldModel === "real"
      ? await openStakePositionWithAdvance(ctx.signer, ctx.getToken, { from: "sol", lamports }, months, market.stake?.token, onStep)
      : await openPositionWithAdvance(ctx.signer, ctx.getToken, simSharesFor(lamports, market), months, onStep);
  return { positionPubkey: opened.position, gemas: issued, signatures: [opened.signature] };
}
