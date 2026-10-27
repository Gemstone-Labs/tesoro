import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "./demo-client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

/**
 * Refusals after which the Player's wallet takes over: the sponsor will not pay for this Player or Game right now, but the
 * step is permissionless and valid, so whoever has SOL can still send it. A delisted or upgraded Game ("unknown-program")
 * must not strand a Match whose Players hold SOL. Not here: "would-fail" and "costs-too-much" (the wallet would pay for a
 * step that fails or is not the one we expect) and "chain" (the Match moved on).
 */
const WALLET_TAKES_OVER = new Set(["unknown-program", "not-your-match", "match-limit", "no-account", "too-many-failures", "account-limit"]);

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
      if (!(e instanceof SponsorError && (e.selfPay || WALLET_TAKES_OVER.has(e.code)))) throw e;
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
