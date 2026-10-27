import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "./demo-client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

/**
 * Sends one of a Game's permissionless base-layer steps (`finalize`, `refund_untabled`, `close_assignment`) with the relayer
 * as caller, so the Player's wallet pays nothing. `ixFor(caller)` builds the instruction (null when there is nothing to do:
 * resolves ""); `pay()` is the old path, used only when free transactions are paused or empty or the wallet cannot sign a
 * sponsored transaction. A refusal or a chain failure is thrown (the Match moved on), never retried from the wallet.
 */
export async function stepFree(
  signer: ChainSigner,
  getToken: GetToken,
  ixFor: (caller: PublicKey) => Promise<TransactionInstruction | null>,
  pay: () => Promise<string>,
): Promise<string> {
  if (signer.signSerialized) {
    try {
      const { relayer, paused } = await sponsorStatus();
      if (!paused) {
        const ix = await ixFor(new PublicKey(relayer));
        return ix ? await sponsoredSend(signer, getToken, [ix]) : "";
      }
    } catch (e) {
      if (!(e instanceof SponsorError && e.selfPay)) throw e;
    }
  }
  return pay();
}

interface FinalizingGame<A, P> {
  finalizeIx(caller: PublicKey, a: A): Promise<TransactionInstruction | null>;
  finalize(payer: P, a: A): Promise<string>;
}

/** Settles a Match from its committed table. Resolves with "" when the Match is already settled. */
export const finalizeFree = <A, P>(game: FinalizingGame<A, P>, signer: ChainSigner, getToken: GetToken, a: A) =>
  stepFree(signer, getToken, (caller) => game.finalizeIx(caller, a), () => game.finalize(signer as unknown as P, a));

/** Refunds a joined Match that no table was ever assigned to (the Game's `refund_untabled`). */
export const refundUntabledFree = <P>(
  game: { refundUntabledIx(caller: PublicKey, match: PublicKey): Promise<TransactionInstruction>; refundUntabled(payer: P, match: PublicKey): Promise<string> },
  signer: ChainSigner,
  getToken: GetToken,
  match: PublicKey,
) => stepFree(signer, getToken, (caller) => game.refundUntabledIx(caller, match), () => game.refundUntabled(signer as unknown as P, match));

/** Closes a finished Match's Assignment (the Game's `close_assignment`); its rent goes back to the operator, not the caller. */
export const closeAssignmentFree = <A, P>(
  game: { closeAssignmentIx(caller: PublicKey, a: A): Promise<TransactionInstruction>; closeAssignment(payer: P, a: A): Promise<string> },
  signer: ChainSigner,
  getToken: GetToken,
  a: A,
) => stepFree(signer, getToken, (caller) => game.closeAssignmentIx(caller, a), () => game.closeAssignment(signer as unknown as P, a));
