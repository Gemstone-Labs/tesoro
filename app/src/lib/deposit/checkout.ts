import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "@/lib/chain/demo-client";
import { CLUSTER } from "@/lib/cluster-settings";
import { RATE_SCALE, rateAt, type NativeMarket } from "@/lib/chain/native";
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
  /** Makes sure the wallet holds `lockLamports` of SOL to lock. Resolves once it does. */
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
    const need = simSharesFor(lockLamports, ctx.market);
    if (ctx.market.simSol >= need) return;
    await getTestSimSol(ctx.signer, ctx.getToken, (s) => ctx.onStep?.(s));
  },
};

/** The checkout this cluster deposits through; null on mainnet until a card provider is connected. */
export const activeCheckout = (): DepositCheckout | null => (CLUSTER.yieldModel === "simulated" ? testCheckout : null);
