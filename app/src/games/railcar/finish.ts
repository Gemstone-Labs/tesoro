/**
 * Finishing a ride after Impact, from any page of a Player the result pays, and from the keeper's safety sweep: Railcar's
 * `reveal_ride` (the ride for the round history, once per car) and `finalize` (core freezes the result), or core's refund
 * once the car's refund time has passed with no result; then room for winners whose stores are short, every settle chunk
 * the shared planner sizes (to the compute target when `simulate` is given), every seat close, the core car's close and,
 * after a core refund, Railcar's Car. Every step is permissionless: `caller` is the relayer (the page's seat key vouches
 * for the request), so a Player's wallet signs none of it. Idempotent: two pages finishing the same car only race to the
 * same state. Each step sends only the instructions `finish-steps.ts` lists for it.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { refundCarIx, seatMarkPda } from "../../lib/chain/many-seat";
import { closeIxs, loadCar, planSeatChunk, roomIxs } from "../../lib/chain/many-seat-plan";
import type { Core, Reader } from "../../lib/chain/settle-plan";
import { carPda, closeRailcarCarIx, decodeCarAccount, finalizeIx, revealRideIx } from "./chain";
import { assertStepIxs, type FinishStep } from "./finish-steps";

export type { FinishStep } from "./finish-steps";

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
  /** Whether these instructions fit one transaction together (the page's seat close with the car's); assumed when absent. */
  fitsTx?(ixs: TransactionInstruction[]): boolean;
  /** The page's own Account: its seat closes last, with the car (after it closes, the seat key names no seat in the car). */
  mine?: PublicKey;
  send(ixs: TransactionInstruction[], step: FinishStep): Promise<unknown>;
  /** Compute units a dry run of a chunk uses (null when unknown): chunks then take fewer steps until under the target. */
  simulate?(ix: TransactionInstruction): Promise<number | null>;
  /** Stops after this many sends (a page does a share and leaves the rest to the next poll). */
  maxSends?: number;
  /** Unix seconds now: from the car's refund time on, a car with no result is refunded through core. */
  now?: number;
  /** Also close Railcar's Car after a core refund (`close-ride`): the keeper's sweep, which pays itself; no seat key can vouch for it. */
  closeRide?: boolean;
}

export interface FinishResult {
  done: boolean;
  sent: FinishStep[];
  /** Why it stopped before the end (nothing to do yet, a missing book, the send cap). */
  waiting?: "not-committed" | "missing-book" | "cap" | "no-car" | "car-close-left";
}

export async function finishRide(d: RideFinishDeps): Promise<FinishResult> {
  const sent: FinishStep[] = [];
  const cap = d.maxSends ?? Number.MAX_SAFE_INTEGER;
  let roomDone = false;
  const send = async (ixs: TransactionInstruction[], step: FinishStep) => {
    assertStepIxs(step, ixs);
    await d.send(ixs, step);
    sent.push(step);
  };
  for (;;) {
    if (sent.length >= cap) return { done: false, sent, waiting: "cap" };
    const l = await loadCar(d.read, d.match);
    if (!l || l.car.stage === "closed") {
      // After a core refund Railcar's Car is still open (finalize closes it otherwise): it closes once core's car has.
      const [info] = await d.read.many([carPda(d.carNo)]);
      const car = info && decodeCarAccount(info.data);
      if (!d.closeRide || !car || !car.tesoroMatch.equals(d.match)) return { done: true, sent };
      await send([closeRailcarCarIx(d.caller, { ...car, carNo: d.carNo })], "close-ride");
      continue;
    }
    switch (l.car.stage) {
      case "boarding":
        return { done: false, sent, waiting: "no-car" };
      case "departed": {
        if (d.now !== undefined && d.now >= l.car.refundAfter) {
          await send([refundCarIx(d.caller, l.car)], "refund");
          break;
        }
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
        if (!ixs.length) return { done: false, sent, waiting: "no-car" };
        const carClose = l.seats.filter((s) => s.seated).length === ixs.length - 1 ? ixs.pop()! : null;
        // A page's seat key vouches for its requests through its own seat: that seat closes last, in the car's close.
        const mark = d.mine && seatMarkPda(d.match, d.mine);
        const at = mark ? ixs.findIndex((ix) => ix.keys.some((k) => k.pubkey.equals(mark))) : -1;
        const own = carClose && at >= 0 ? ixs.splice(at, 1)[0] : null;
        for (const ix of ixs) {
          if (sent.length >= cap) return { done: false, sent, waiting: "cap" };
          await send([ix], "close-seat");
        }
        if (carClose) {
          if (sent.length >= cap) return { done: false, sent, waiting: "cap" };
          if (own && !(d.fitsTx?.([own, carClose]) ?? true)) {
            // too big together: the seat closes, and another rider's page or the keeper's sweep closes the car
            await send([own], "close-seat");
            return { done: false, sent, waiting: "car-close-left" };
          }
          await send(own ? [own, carClose] : [carClose], "close-car");
        }
        break;
      }
    }
  }
}
