import { activeCheckout, type CheckoutContext, type DepositCheckout } from "./checkout";
import { openPackLock, type PackLockResult } from "./open-pack-lock";
import type { PackQuote } from "./packs";

/** Which part of a deposit is running: the money arriving, or the deposit being added. */
export type DepositPhase = "paying" | "adding";

/** What survives a failed try: money that already arrived must not be asked for twice. */
export interface DepositProgress {
  funded: boolean;
}

interface Deps {
  checkout: DepositCheckout | null;
  openLock: typeof openPackLock;
}

const live: Deps = { get checkout() { return activeCheckout(); }, openLock: openPackLock };

/**
 * One deposit: the checkout puts the SOL in the wallet, then the Lock opens. After a failed try, call it again with the same
 * `progress`: if the SOL had arrived, only the Lock is retried.
 */
export async function runPackDeposit(
  ctx: CheckoutContext,
  quote: PackQuote,
  progress: DepositProgress,
  onPhase: (phase: DepositPhase) => void,
  deps: Deps = live,
): Promise<PackLockResult> {
  if (!deps.checkout) throw new Error("Card deposits are coming soon.");
  if (!progress.funded) {
    onPhase("paying");
    await deps.checkout.fund(ctx, quote.lockLamports);
    progress.funded = true;
  }
  onPhase("adding");
  return deps.openLock(ctx, { amountLamports: quote.lockLamports });
}
