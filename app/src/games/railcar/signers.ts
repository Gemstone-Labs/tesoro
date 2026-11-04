/**
 * Who signs what in a Railcar ride. Privy bills every wallet signature, so the wallet signs one thing: the boarding.
 *
 * - Boarding: the wallet (with the seat key co-signing once core names seat keys on seats, seat keys ticket 08).
 * - Jump: the seat key once Railcar's `jump` acts for the wallet through it (`JUMP_TAKES_SEAT_KEY`); the wallet until then.
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
 * The one switch for the Jump: true once Railcar's `jump` accepts the seat key the seat names (rc-06's follow-up with seat
 * keys ticket 08). Until then the program checks the wallet, so the wallet signs each Jump.
 */
export const JUMP_TAKES_SEAT_KEY = false;

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

/**
 * Sends one finish step with the relayer paying, vouched for by the seat key. Null without a seat key the car names: the page
 * then leaves the finish to another rider's page or the keeper's safety sweep, and never asks the wallet.
 */
export function finishSender(seat: SeatKey | null, getToken: GetToken, seatsTakeKeys = SEATS_TAKE_SEAT_KEYS): ((ixs: TransactionInstruction[]) => Promise<string>) | null {
  if (!seat || !seatsTakeKeys) return null;
  return (ixs) => sponsoredSend(seat, getToken, ixs);
}
