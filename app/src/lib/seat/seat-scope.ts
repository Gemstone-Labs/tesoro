/**
 * What a seat key may ask the server to send: only a Match's own finish steps. Moves in the rollup never travel through the
 * server, and entering, Redeem, Unlock, Protections, profile, admin and deposits need the wallet. The server enforces the same
 * list (`SEAT_STEP_NAMES` in server/sponsor/service.ts); refusing here as well keeps a seat key from being offered to code that
 * was meant for the wallet.
 */
import { SeatScopeError } from "./seat-scope-error";
import type { TransactionInstruction } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import holdemIdl from "@/lib/chain/idl/holdem.json";
import railcarIdl from "@/lib/chain/idl/railcar.json";

type IdlLike = { instructions: { name: string; discriminator: number[] }[] };

const disc = (idl: IdlLike, name: string): string => {
  const i = idl.instructions.find((x) => x.name === name);
  if (!i) throw new Error(`No instruction ${name} in the IDL`);
  return i.discriminator.join(",");
};

/** Core finish steps, the Game steps every Game shares (same discriminators in each Game), and a Railcar car's finish. */
const SEAT_STEPS = new Set<string>([
  ...["match_chunk", "close_match", "refund_match"].map((n) => disc(coreIdl as IdlLike, n)),
  ...["finalize", "refund_untabled", "close_assignment"].map((n) => disc(holdemIdl as IdlLike, n)),
  ...["many_seat_chunk", "reserve_many_seat_room", "close_many_seat", "close_many_seat_match", "refund_many_seat_match"].map((n) => disc(coreIdl as IdlLike, n)),
  ...["check_departure", "finalize"].map((n) => disc(railcarIdl as IdlLike, n)),
]);

export const isSeatStep = (ix: Pick<TransactionInstruction, "data">): boolean => SEAT_STEPS.has(Array.from(ix.data.subarray(0, 8)).join(","));


/** Throws unless every instruction is a finish step a seat key may ask for. */
export function assertSeatMay(ixs: Pick<TransactionInstruction, "data">[]): void {
  if (ixs.length === 0 || !ixs.every(isSeatStep)) throw new SeatScopeError();
}

export { SeatScopeError };
