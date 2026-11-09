import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { SponsorError } from "@/lib/chain/sponsor-client";

/**
 * The page's step-off. The seat key the seat names signs it and the relayer pays: no wallet signature (seat-keys user story
 * 9; core takes the key through `acts_for`). Without that key on this device, or when the sponsor refuses it, the wallet
 * steps off as before: through the sponsor, else paying itself. A seat-key step-off that failed on chain is not resent.
 */
export async function sendStepOff(d: {
  wallet: ChainSigner;
  seat: ChainSigner | null;
  /** The key the Player's seat names (`SeatView.signer`). */
  seatSigner: PublicKey;
  build(caller: PublicKey): Promise<TransactionInstruction>;
  sponsored(signer: ChainSigner, ixs: TransactionInstruction[]): Promise<string>;
  selfPaid(signer: ChainSigner, ixs: TransactionInstruction[]): Promise<string>;
}): Promise<string> {
  if (d.seat && d.seatSigner.equals(d.seat.publicKey)) {
    try {
      return await d.sponsored(d.seat, [await d.build(d.seat.publicKey)]);
    } catch (e) {
      if (!(e instanceof SponsorError)) throw e;
    }
  }
  const ix = await d.build(d.wallet.publicKey);
  return d.sponsored(d.wallet, [ix]).catch(() => d.selfPaid(d.wallet, [ix]));
}
