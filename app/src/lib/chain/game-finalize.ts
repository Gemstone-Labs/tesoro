import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { GetToken } from "./demo-client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

interface FinalizingGame<A, P> {
  finalizeIx(caller: PublicKey, a: A): Promise<TransactionInstruction | null>;
  finalize(payer: P, a: A): Promise<string>;
}

/**
 * Settles a Match from its committed table (every Game's permissionless `finalize`). The relayer is the caller, so it pays the
 * fee and the receipt's rent and a Player with no SOL still sees the result. Only when free transactions are paused or empty
 * does the wallet pay, as before. Resolves with "" when the Match is already settled.
 */
export async function finalizeFree<A, P>(game: FinalizingGame<A, P>, signer: ChainSigner, getToken: GetToken, a: A): Promise<string> {
  if (signer.signSerialized) {
    try {
      const { relayer, paused } = await sponsorStatus();
      if (!paused) {
        const ix = await game.finalizeIx(new PublicKey(relayer), a);
        return ix ? await sponsoredSend(signer, getToken, [ix]) : "";
      }
    } catch (e) {
      if (!(e instanceof SponsorError && e.selfPay)) throw e;
    }
  }
  return game.finalize(signer as unknown as P, a);
}
