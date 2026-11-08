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
import { RIDE_STEP_KEYS } from "@/games/railcar/finish-steps";

type IdlLike = { instructions: { name: string; discriminator: number[] }[] };

const disc = (idl: IdlLike, name: string): string => {
  const i = idl.instructions.find((x) => x.name === name);
  if (!i) throw new Error(`No instruction ${name} in the IDL`);
  return i.discriminator.join(",");
};

/** A head-to-head Match's finish: core's steps and the Game steps every Game shares (same discriminators in each Game). */
const SEAT_STEPS = new Set<string>([...["match_chunk", "close_match", "refund_match"].map((n) => disc(coreIdl as IdlLike, n)), ...["finalize", "refund_untabled", "close_assignment"].map((n) => disc(holdemIdl as IdlLike, n))]);

const discOf = (ix: Pick<TransactionInstruction, "data">) => Array.from(ix.data.subarray(0, 8)).join(",");

/** A finish step: a head-to-head one, or one a Railcar page sends after boarding (`finish-steps.ts`, by program). */
export const isSeatStep = (ix: Pick<TransactionInstruction, "data" | "programId">): boolean => SEAT_STEPS.has(discOf(ix)) || RIDE_STEP_KEYS.has(`${ix.programId.toBase58()}:${discOf(ix)}`);

/** Throws unless every instruction is a finish step a seat key may ask for. */
export function assertSeatMay(ixs: Pick<TransactionInstruction, "data" | "programId">[]): void {
  if (ixs.length === 0 || !ixs.every(isSeatStep)) throw new SeatScopeError();
}

export { SeatScopeError };
