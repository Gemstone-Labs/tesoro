/**
 * Finishing a ride after Impact, from any page of a Player the result pays: Railcar's `reveal_ride` (the ride for the round
 * history, once per car) and `finalize` (core freezes the result),
 * room for winners whose stores are short, every settle chunk the shared planner sizes (to the compute target when `simulate` is given), every seat close and the car's
 * close. Every step is permissionless: `caller` is the relayer (the page's seat key vouches for the request), so a
 * Player's wallet signs none of it. Idempotent: two pages finishing the same car only race to the same state.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { closeIxs, loadCar, planSeatChunk, roomIxs } from "../../lib/chain/many-seat-plan";
import type { Core, Reader } from "../../lib/chain/settle-plan";
import { carPda, decodeCarAccount, finalizeIx, revealRideIx } from "./chain";

export interface RideFinishDeps {
  read: Reader;
  core: Core;
  /** Who calls and pays every step: the relayer when sponsored. */
  caller: PublicKey;
  /** The car and its core Match. */
  carNo: bigint;
  match: PublicKey;
  /** Whether base holds the Table with this car's ride over (finalize reads it). */
  committed(): Promise<boolean>;
  /** Whether one step fits a transaction as the sender compiles it. */
  fits(ix: TransactionInstruction): boolean;
  send(ixs: TransactionInstruction[], step: FinishStep): Promise<unknown>;
  /** Compute units a dry run of a chunk uses (null when unknown): chunks then take fewer steps until under the target. */
  simulate?(ix: TransactionInstruction): Promise<number | null>;
  /** Stops after this many sends (a page does a share and leaves the rest to the next poll). */
  maxSends?: number;
}

export type FinishStep = "reveal" | "finalize" | "room" | "chunk" | "close-seat" | "close-car";

export interface FinishResult {
  done: boolean;
  sent: FinishStep[];
  /** Why it stopped before the end (nothing to do yet, a missing book, the send cap). */
  waiting?: "not-committed" | "missing-book" | "cap" | "no-car";
}

export async function finishRide(d: RideFinishDeps): Promise<FinishResult> {
  const sent: FinishStep[] = [];
  const cap = d.maxSends ?? Number.MAX_SAFE_INTEGER;
  let roomDone = false;
  const send = async (ixs: TransactionInstruction[], step: FinishStep) => {
    await d.send(ixs, step);
    sent.push(step);
  };
  for (;;) {
    if (sent.length >= cap) return { done: false, sent, waiting: "cap" };
    const l = await loadCar(d.read, d.match);
    if (!l || l.car.stage === "closed") return { done: true, sent };
    switch (l.car.stage) {
      case "boarding":
        return { done: false, sent, waiting: "no-car" };
      case "departed": {
        if (!(await d.committed())) return { done: false, sent, waiting: "not-committed" };
        const [info] = await d.read.many([carPda(d.carNo)]);
        if (!info) return { done: false, sent, waiting: "no-car" };
        const car = decodeCarAccount(info.data);
        if (!car.revealed) await send([revealRideIx(d.caller, { ...car, carNo: d.carNo }, l.car.pages)], "reveal");
        else await send([finalizeIx(d.caller, { ...car, carNo: d.carNo }, l.car.pages)], "finalize");
        break;
      }
      case "settling":
      case "refunding": {
        if (!roomDone) {
          roomDone = true;
          for (const ix of await roomIxs(d.read, d.caller, l)) await send([ix], "room");
          break;
        }
        const plan = await planSeatChunk(d.core, d.read, d.caller, l, d.fits, { simulate: d.simulate && ((ix) => d.simulate!(ix)) });
        if (!plan) return { done: false, sent, waiting: "no-car" };
        if (plan.missing.length) return { done: false, sent, waiting: "missing-book" };
        await send([plan.ix], "chunk");
        break;
      }
      case "paid": {
        const ixs = await closeIxs(d.read, d.caller, l);
        for (const [i, ix] of ixs.entries()) {
          if (sent.length >= cap) return { done: false, sent, waiting: "cap" };
          await send([ix], i === ixs.length - 1 && l.seats.filter((s) => s.seated).length === ixs.length - 1 ? "close-car" : "close-seat");
        }
        if (!ixs.length) return { done: false, sent, waiting: "no-car" };
        break;
      }
    }
  }
}
