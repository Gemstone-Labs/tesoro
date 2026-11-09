import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { closeCarIx, closeSeatIx, refundCarIx, reserveRoomIx, seatChunkIx, stepOffIx, type SeatView } from "../../lib/chain/many-seat";
import { initCkptPageIx } from "../../lib/chain/settle-plan";
import { isSeatStep } from "../../lib/seat/seat-scope";
import { SEAT_STEP_NAMES } from "../../server/sponsor/service";
import { RAILCAR_PROGRAM_ID, checkDepartureIx, closeRailcarCarIx, finalizeIx, revealRideIx } from "./chain";
import { RIDE_STEP_IXS, SWEEP_ONLY_STEPS, assertStepIxs, type RideStepName } from "./finish-steps";

const key = () => Keypair.generate().publicKey;
const nameOf = (ix: TransactionInstruction) => new BorshInstructionCoder((ix.programId.equals(RAILCAR_PROGRAM_ID) ? railcarIdl : coreIdl) as unknown as Idl).decode(Buffer.from(ix.data))!.name;

const car = { address: key(), payer: key(), opener: key(), n: 3n, game: RAILCAR_PROGRAM_ID };
const seat = { index: 2, player: key(), funder: key(), pot: key(), hold: 0 } as SeatView;
const ride = { carNo: 3n, table: 1, tesoroMatch: car.address, payer: key() };
const caller = key();

/** What each step's builder makes, as the finish (finish.ts) and the page's departure send them. */
const built: Record<RideStepName, TransactionInstruction[]> = {
  depart: [checkDepartureIx(3n, car.address)],
  "step-off": [stepOffIx({ caller, car: car.address, seat, markPayer: key(), potPayer: key(), sponsor: true })],
  reveal: [revealRideIx(caller, ride, 1)],
  finalize: [finalizeIx(caller, ride, 1)],
  refund: [refundCarIx(caller, car)],
  room: [reserveRoomIx(caller, car, key(), 4)],
  pages: [initCkptPageIx(caller, key(), 1, 0), initCkptPageIx(caller, key(), 3, 0)],
  chunk: [seatChunkIx(caller, car.address, 7, [])],
  "close-seat": [closeSeatIx({ caller, car: car.address, seat, markPayer: key(), potPayer: key(), sponsor: true })],
  "close-car": [closeSeatIx({ caller, car: car.address, seat, markPayer: key(), potPayer: key(), sponsor: true }), closeCarIx(caller, car, [])],
  "close-ride": [closeRailcarCarIx(caller, ride)],
};

describe("the one list of what a Railcar page sends after boarding", () => {
  it("lists what each step's builder makes", () => {
    for (const [step, ixs] of Object.entries(built) as [RideStepName, TransactionInstruction[]][]) expect(() => assertStepIxs(step, ixs), step).not.toThrow();
  });

  it("every step a page sends is one its seat key may ask for, on the client and on the sponsor", () => {
    for (const step of Object.keys(RIDE_STEP_IXS) as RideStepName[]) {
      if (SWEEP_ONLY_STEPS.includes(step)) continue;
      for (const ix of built[step]) {
        expect(isSeatStep(ix), `${step}: ${nameOf(ix)} on the client`).toBe(true);
        expect(SEAT_STEP_NAMES.has(nameOf(ix)), `${step}: ${nameOf(ix)} on the sponsor`).toBe(true);
      }
    }
  });

  it("the finish refuses to send an instruction its step does not list", () => {
    expect(() => assertStepIxs("chunk", [closeCarIx(caller, car, [])])).toThrow(/not on its list/);
    // the same discriminator from another program is another instruction
    const other = { ...built.finalize[0], programId: new PublicKey(coreIdl.address) } as TransactionInstruction;
    expect(() => assertStepIxs("finalize", [other])).toThrow(/not on its list/);
  });

  it("keeps the seat key away from the keeper-only close of Railcar's Car, which no seat can vouch for", () => {
    expect(isSeatStep(built["close-ride"][0])).toBe(false);
  });
});
