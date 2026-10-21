import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "@/lib/chain/demo-client";
import { CLUSTER } from "@/lib/cluster-settings";
import { getChain } from "@/lib/chain/client";
import { RATE_SCALE, fetchNativeMarket, rateAt, type NativeMarket } from "@/lib/chain/native";
import { getTestSimSol } from "@/lib/chain/native-flow";

export interface CheckoutContext {
  signer: ChainSigner;
  getToken: GetToken;
  market: NativeMarket;
  onStep?: (step: string) => void;
}

/**
 * How a deposit's money reaches the Player's wallet as SOL. Test mode fills it with test SOL; on mainnet a card
 * provider's checkout does it (not connected yet: the founders are choosing one).
 */
export interface DepositCheckout {
  id: "test" | "card";
  /** The fee taken from the deposit, basis points. */
  feeBps: number;
  /**
   * Makes sure the wallet holds `lockLamports` of SOL to lock. Resolves once it does. Called again right before the Lock
   * opens with the amount sized on the price at that moment, which can be a few lamports more than the payment brought:
   * Tesoro covers that dust (cents), so the Player always gets the Gemas the pack showed.
   */
  fund(ctx: CheckoutContext, lockLamports: bigint): Promise<void>;
}

/** test SOL needed for a Lock of `lockLamports` (simSOL is priced at the pool rate). */
export const simSharesFor = (lockLamports: bigint, market: NativeMarket): bigint => {
  const rate = rateAt(market.pool);
  return rate > 0n ? (lockLamports * RATE_SCALE + rate - 1n) / rate : 0n;
};

/** SIMULATED: claims test SOL from the faucet (10 an hour, more than the largest pack) when the wallet doesn't hold enough. No card, no fee. */
export const testCheckout: DepositCheckout = {
  id: "test",
  feeBps: 0,
  async fund(ctx, lockLamports) {
    // The balance as it is now: the page's read can be minutes old, and the faucet is limited to once an hour.
    const market = await fetchNativeMarket(getChain().base, ctx.signer.publicKey);
    if (market.simSol >= simSharesFor(lockLamports, market)) return;
    await getTestSimSol(ctx.signer, ctx.getToken, (s) => ctx.onStep?.(s));
  },
};

/** The checkout this cluster deposits through; null on mainnet until a card provider is connected. */
export const activeCheckout = (): DepositCheckout | null => (CLUSTER.yieldModel === "simulated" ? testCheckout : null);
