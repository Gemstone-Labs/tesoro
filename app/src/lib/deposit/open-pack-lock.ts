import { CLUSTER } from "@/lib/cluster-settings";
import { getChain } from "@/lib/chain/client";
import { fetchNativeMarket } from "@/lib/chain/native";
import { openPositionWithAdvance, openStakePositionWithAdvance } from "@/lib/chain/native-flow";
import { isPriceMoved } from "@/lib/errors";
import { simSharesFor, type CheckoutContext } from "./checkout";
import { PACK_MONTHS, lamportsForGemas, packMarket } from "./packs";

export interface PackLockResult {
  positionPubkey: string;
  /** Gemas the Advance issued: the promised number. */
  gemas: number;
  signatures: string[];
}

/** After the first try, a refused Advance (the price moved) is re-sized and sent again at most this many times. */
export const PACK_RETRIES = 2;

/**
 * The one place the Simple view touches the chain to deposit: opens a SOL Lock with a `months` Length that issues `gemas`,
 * and takes its Advance in the same transaction, with `gemas` as the program's floor (`min_gemas`). The market is read again
 * from the chain first, so the Lock is sized on the price the Advance will use; `fund` tops the wallet up to that Lock (the
 * payment can be a few lamports short). When the price moves before the transaction lands the program refuses it and nothing
 * is taken: the price, APY and fees are read again, the Lock is re-sized and the Advance sent again. Only a definite refusal
 * is retried, never a send whose fate is unknown.
 */
export async function openPackLock(
  ctx: CheckoutContext,
  { gemas, months = PACK_MONTHS, fund }: { gemas: number; months?: number; fund: (lamports: bigint) => Promise<void> },
): Promise<PackLockResult> {
  const onStep = (s: string) => ctx.onStep?.(s === "Locking your SOL" || s === "Staking and locking your SOL" ? "Adding your deposit" : s);
  for (let attempt = 0; ; attempt++) {
    const market = await fetchNativeMarket(getChain().base, ctx.signer.publicKey);
    const m = packMarket(market);
    if (!m) throw new Error("The SOL price is updating. Try again in a few minutes.");
    const lamports = lamportsForGemas(BigInt(gemas), m, months);
    await fund(lamports);
    const minGemas = BigInt(gemas);
    try {
      const opened =
        CLUSTER.yieldModel === "real"
          ? await openStakePositionWithAdvance(ctx.signer, ctx.getToken, { from: "sol", lamports }, months, minGemas, market.stake?.token, onStep)
          : await openPositionWithAdvance(ctx.signer, ctx.getToken, simSharesFor(lamports, market), months, minGemas, onStep);
      return { positionPubkey: opened.position, gemas, signatures: [opened.signature] };
    } catch (e) {
      if (!isPriceMoved(e) || attempt >= PACK_RETRIES) throw e;
    }
  }
}
