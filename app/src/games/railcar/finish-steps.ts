/**
 * Every instruction sent after boarding a Railcar car, by step: the departure check and each step of the finish
 * (`finishRide`). The seat key's scope (lib/seat/seat-scope.ts, client) and the sponsor's seat-key rule
 * (server/sponsor/service.ts) both read their allow-lists from here, and `finishRide` refuses to send an instruction that
 * is not on its step's list, so a new step cannot be left off either allow-list.
 *
 * `close-ride` (Railcar's `close_car` after a core refund) is the one step no seat key can vouch for: by then core's car
 * and its seat marks are closed, so nothing names the Player's key. The keeper's safety sweep sends it, paying itself.
 */
import type { TransactionInstruction } from "@solana/web3.js";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";

export type FinishStep = "reveal" | "finalize" | "refund" | "room" | "pages" | "chunk" | "close-seat" | "close-car" | "close-ride";
export type RideStepName = FinishStep | "depart";

type Program = "core" | "railcar";

/** Which program's instruction each step sends. */
export const RIDE_STEP_IXS: Record<RideStepName, readonly { program: Program; name: string }[]> = {
  depart: [{ program: "railcar", name: "check_departure" }],
  reveal: [{ program: "railcar", name: "reveal_ride" }],
  finalize: [{ program: "railcar", name: "finalize" }],
  refund: [{ program: "core", name: "refund_many_seat_match" }],
  room: [{ program: "core", name: "reserve_many_seat_room" }],
  // the checkpoint pages a chunk's fee cut needs (the sponsor checks each is the book's and missing)
  pages: [{ program: "core", name: "init_ckpt_page" }],
  chunk: [{ program: "core", name: "many_seat_chunk" }],
  "close-seat": [{ program: "core", name: "close_many_seat" }],
  // the car's close, with the sending page's own seat close in the same transaction
  "close-car": [
    { program: "core", name: "close_many_seat_match" },
    { program: "core", name: "close_many_seat" },
  ],
  "close-ride": [{ program: "railcar", name: "close_car" }],
};

type IdlLike = { address: string; instructions: { name: string; discriminator: number[] }[] };
const IDLS: Record<Program, IdlLike> = { core: coreIdl as IdlLike, railcar: railcarIdl as IdlLike };

const discOf = (program: Program, name: string): string => {
  const ix = IDLS[program].instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`No instruction ${name} in the ${program} IDL`);
  return ix.discriminator.join(",");
};

/** Steps only the keeper's sweep sends (see above). */
export const SWEEP_ONLY_STEPS: readonly RideStepName[] = ["close-ride"];

const all = (Object.keys(RIDE_STEP_IXS) as RideStepName[]).filter((s) => !SWEEP_ONLY_STEPS.includes(s)).flatMap((s) => RIDE_STEP_IXS[s]);

/** Every instruction name a seat key may ask for after boarding (the sponsor matches names it decoded per program). */
export const RIDE_STEP_NAMES: readonly string[] = [...new Set(all.map((i) => i.name))];

/** The same instructions as program id and discriminator (`programId:disc`). */
export const RIDE_STEP_KEYS: ReadonlySet<string> = new Set(all.map((i) => `${IDLS[i.program].address}:${discOf(i.program, i.name)}`));

/** Throws unless every instruction is one `step` sends. */
export function assertStepIxs(step: RideStepName, ixs: TransactionInstruction[]): void {
  const ok = new Set(RIDE_STEP_IXS[step].map((i) => `${IDLS[i.program].address}:${discOf(i.program, i.name)}`));
  for (const ix of ixs) {
    if (!ok.has(`${ix.programId.toBase58()}:${Array.from(ix.data.subarray(0, 8)).join(",")}`)) throw new Error(`The ${step} step sent an instruction that is not on its list (finish-steps.ts)`);
  }
}
