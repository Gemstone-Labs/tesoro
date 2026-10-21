import { CLUSTER } from "@/lib/cluster-settings";
import { openPositionWithAdvance, openStakePositionWithAdvance } from "@/lib/chain/native-flow";
import { quoteNativeAdvance } from "@/lib/chain/native";
import { simSharesFor, type CheckoutContext } from "./checkout";
import { PACK_MONTHS, packMarket } from "./packs";

export interface PackLockResult {
  positionPubkey: string;
  /** Gemas the Advance issued, as quoted when it was sent. */
  gemas: number;
  signatures: string[];
}

/**
 * The one place the Simple view touches the chain to deposit: opens a SOL Lock of `amountLamports` with a `months` Length
 * and takes its Advance. The economy upgrade swaps this function's body; its shape stays.
 */
export async function openPackLock(
  ctx: CheckoutContext,
  { amountLamports, months = PACK_MONTHS }: { amountLamports: bigint; months?: number },
): Promise<PackLockResult> {
  const m = packMarket(ctx.market);
  if (!m) throw new Error("The SOL price is updating. Try again in a few minutes.");
  const gemas = Number(quoteNativeAdvance(amountLamports, m.apyBps, months, m.priceMicroUsd, m.yieldFeeBps).gemas);
  const onStep = (s: string) => ctx.onStep?.(s === "Locking your SOL" || s === "Staking and locking your SOL" ? "Adding your deposit" : s);
  const opened =
    CLUSTER.yieldModel === "real"
      ? await openStakePositionWithAdvance(ctx.signer, ctx.getToken, { from: "sol", lamports: amountLamports }, months, ctx.market.stake?.token, onStep)
      : await openPositionWithAdvance(ctx.signer, ctx.getToken, simSharesFor(amountLamports, ctx.market), months, onStep);
  return { positionPubkey: opened.position, gemas, signatures: [opened.signature] };
}
