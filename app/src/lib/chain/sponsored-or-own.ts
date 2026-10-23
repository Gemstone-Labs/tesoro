import "./polyfill";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

/**
 * Sends one sign-up step (ticket 18c). The relayer pays first, with the step built for it (`payer` is the relayer and
 * `sponsored` says the sponsor account repays it); when it cannot or will not (paused, over a limit, a wallet that cannot
 * take part), the wallet pays its own rent and fee, topping up on the test cluster. Each step travels alone: the relayer
 * only sponsors lone sign-up instructions.
 */
export async function sendSponsoredOrOwn(
  signer: ChainSigner,
  getToken: GetToken,
  build: (payer: PublicKey, sponsored: boolean) => Promise<TransactionInstruction[]>,
  onFund?: () => void,
): Promise<string> {
  if (signer.signSerialized) {
    try {
      const { relayer, paused } = await sponsorStatus();
      if (!paused) return await sponsoredSend(signer, getToken, await build(new PublicKey(relayer), true));
    } catch (e) {
      if (!(e instanceof SponsorError)) throw e;
    }
  }
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, onFund);
  return getChain().sendBase(signer, await build(signer.publicKey, false));
}
