import type { PublicKey, Transaction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { SeatKey } from "./seat-key";
import { signInto } from "./seat-key";

/**
 * The signer of an entry: the wallet, plus the seat key the entry names. Both signatures go on the one transaction (the wallet
 * as `player_authority`, the seat key as `seat_signer`), so the Player's wallet signs once. Messages (the request that asks the
 * server to build the entry, when the login alone cannot) are the wallet's.
 */
export function cosigned(wallet: ChainSigner, seat: SeatKey): ChainSigner & { seatKey: PublicKey } {
  return {
    publicKey: wallet.publicKey,
    seatKey: seat.publicKey,
    signMessage: (m) => wallet.signMessage(m),
    signTransaction: async (tx: Transaction) => seat.signTransaction(await wallet.signTransaction(tx)),
    ...(wallet.signSerialized ? { signSerialized: async (raw: Uint8Array) => signInto(await wallet.signSerialized!(raw), seat.publicKey, (m) => seat.signMessage(m)) } : {}),
  };
}

/**
 * The signer of a Ticket step after the opening (staging): the seat key signs the transaction, so the wallet is not asked.
 * `wallet` is the wallet it acts for. Requests to the server are still the wallet's (`signMessage`): they only happen when
 * the login-only entry step was refused, and then the wallet vouches for the step.
 */
export function ticketSteps(wallet: ChainSigner, seat: SeatKey): ChainSigner {
  return {
    publicKey: seat.publicKey,
    wallet: wallet.publicKey,
    signMessage: (m) => wallet.signMessage(m),
    signTransaction: (tx) => seat.signTransaction(tx),
    signSerialized: (raw) => seat.signSerialized(raw),
  };
}
