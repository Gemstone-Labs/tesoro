/**
 * Who signs what in a Railcar ride. Privy bills every wallet signature, so the wallet signs one thing: the boarding.
 *
 * - Boarding: the wallet (with the seat key co-signing once core names seat keys on seats, seat keys ticket 08).
 * - Jump: the seat key the seat names (Railcar's `jump` accepts it through core's `acts_for`, `JUMP_TAKES_SEAT_KEY`).
 * - Brake: a flag on the tick the seat key signs; the wallet only when the seat names no key of this page's (`brakeRoute`).
 * - Signals, starting the ride and commits (rollup, anyone): a key made for the page.
 * - The departure check, finalize, room, every settle chunk and the closes (base, anyone): the relayer calls and pays; the
 *   seat key vouches for the request (the server checks the car names that key in the Player's seat).
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { SEATS_TAKE_SEAT_KEYS } from "@/lib/chain/many-seat";
import type { GetToken } from "@/lib/chain/demo-client";
import { sponsoredSend } from "@/lib/chain/sponsor-client";
import { cosigned } from "@/lib/seat/cosigned";
import type { SeatKey } from "@/lib/seat/seat-key";

/**
 * The one switch for the Jump: Railcar's `jump` accepts the seat key core recorded on the seat (copied into the Table at
 * `start_ride`), so the seat key signs each Jump and the wallet is not asked.
 */
export const JUMP_TAKES_SEAT_KEY = true;

/** The boarding transaction's signer: the wallet, with the seat key co-signing when core takes seat keys. */
export function boardingSigner(wallet: ChainSigner, seat: SeatKey | null, seatsTakeKeys = SEATS_TAKE_SEAT_KEYS): ChainSigner {
  return seatsTakeKeys && seat ? cosigned(wallet, seat) : wallet;
}

/** The seat key named in the join, when core takes one. */
export const joinSeatKey = (seat: SeatKey | null, seatsTakeKeys = SEATS_TAKE_SEAT_KEYS): PublicKey | undefined => (seatsTakeKeys && seat ? seat.publicKey : undefined);

/** The Jump's signer. */
export function jumpSigner(wallet: ChainSigner, seat: SeatKey | null, takesSeatKey = JUMP_TAKES_SEAT_KEY): ChainSigner {
  return takesSeatKey && seat ? seat : wallet;
}

/** How this page sends the Brake: a flag on the next tick the seat key signs, or one tick of its own the wallet signs. */
export type BrakeRoute<W, K> = { kind: "next-tick"; signer: K } | { kind: "wallet"; signer: W } | null;

/**
 * The Brake's route. When the Table seat names this page's seat key, the Brake rides that key's next tick: no prompt.
 * Otherwise (boarded without a seat key, so the seat names the wallet, or on another device) the wallet signs one tick
 * with the Brake, which Railcar takes through `acts_for`: one prompt, and a transaction of its own. That wallet also signs one
 * signal as the ride starts (`earlyCopyDue` in brake.ts), so its first rollup transaction is not the Brake. Null signed out.
 */
export function brakeRoute<W extends { publicKey: PublicKey }, K extends { publicKey: PublicKey }>(wallet: W | null, seat: K | null, seatSigner: PublicKey): BrakeRoute<W, K> {
  if (seat && seatSigner.equals(seat.publicKey)) return { kind: "next-tick", signer: seat };
  return wallet ? { kind: "wallet", signer: wallet } : null;
}

/**
 * Sends one finish step with the relayer paying, vouched for by the seat key. Null without a seat key the car names: the page
 * then leaves the finish to another rider's page or the keeper's safety sweep, and never asks the wallet.
 */
export function finishSender(seat: SeatKey | null, getToken: GetToken, seatsTakeKeys = SEATS_TAKE_SEAT_KEYS): ((ixs: TransactionInstruction[]) => Promise<string>) | null {
  if (!seat || !seatsTakeKeys) return null;
  return (ixs) => sponsoredSend(seat, getToken, ixs);
}
