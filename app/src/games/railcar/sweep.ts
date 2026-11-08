/**
 * The keeper safety sweep's Railcar half, as one function the keeper sends through and the LiteSVM rides drive: for a car
 * whose pages are all gone, the steps a page would have taken (`nextRideStep`), plus what only a late sender weighs: core's
 * refund once the car's refund time has passed, a ride still inside its time, a commit on its way, and a car still
 * Boarding when core's boarding has ended (nobody can join or depart it any more, so every seat steps off home and the
 * car closes). The finish goes through `finishRide`, as a page's does. Reads only; `send` sends.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { settledPda } from "../../lib/chain/basket";
import { boardingEnds, closeCarIx, decodeCar, type CarView } from "../../lib/chain/many-seat";
import { loadCar } from "../../lib/chain/many-seat-plan";
import type { Core, Reader } from "../../lib/chain/settle-plan";
import { returnLinesFor, stepOffFor } from "./step-off";
import { carPda, checkDepartureIx, closeRailcarCarIx, commitTableIx, configPda, decodeCarAccount, decodeConfig, decodeTable, signalIx, skipCarIx, startRideIx, tablePda, type CarAccountView, type TableView } from "./chain";
import { finishRide } from "./finish";
import { nextRideStep, type RideStep } from "./flow";

/** The longest a ride runs once its draw is in (the 10-minute cap with Brakes). */
export const RIDE_CAP_SECS = 10 * 60;
/** `table_kit::COMMIT_RETRY_SECS`: a commit may be repeated this long after the last. */
export const COMMIT_RETRY_SECS = 120;

export type SweepRideAction =
  | { send: "depart" | "start-ride" | "commit" | "finish" | "step-off" }
  /** `signal`; `untilOver`: a signal that leaves the Table short of over found nothing due yet (not a try). */
  | { send: "signal"; untilOver: boolean }
  | { wait: string };

/** What the sweep weighs on top of a page's step. Pure. */
export function sweepRideAction(step: RideStep, f: { core: CarView; rollup: TableView | null; now: number }): SweepRideAction {
  if (f.core.stage === "boarding" && f.now >= boardingEnds(f.core)) return { send: "step-off" };
  // From the refund time on anyone may refund a car core holds no result for, whatever its ride is doing (finishRide).
  if (f.core.stage === "departed" && f.now >= f.core.refundAfter) return { send: "finish" };
  switch (step.kind) {
    case "depart":
    case "start-ride":
      return { send: step.kind };
    case "finalize":
      return { send: "finish" };
    case "signal": {
      const t = f.rollup;
      const pastCap = !!t && t.phase === "riding" && f.now >= t.rideTs + RIDE_CAP_SECS;
      return { send: "signal", untilOver: !pastCap };
    }
    case "commit": {
      const t = f.rollup;
      return t && (t.dirty || f.now >= t.commitAt + COMMIT_RETRY_SECS) ? { send: "commit" } : { wait: "the commit is on its way to base" };
    }
    case "finalize-previous":
      return { wait: "the Table's previous car is finished first" };
    case "wait":
      return { wait: "nothing a page would send yet" };
    default:
      return { wait: `the finisher's step (${step.kind})` };
  }
}

// ---- reading a car's ride ------------------------------------------------------------------------------------------

/** A core car's ride: its Railcar car number and Table, the Car account (null once closed) and the Table on both layers. */
export interface CarRide {
  carNo: bigint;
  table: number;
  car: CarAccountView | null;
  rollup: TableView | null;
  base: TableView | null;
  previousFrozen: boolean;
}

const one = async (read: Reader, key: PublicKey) => (await read.many([key]))[0];

/**
 * Finds the ride of core car `match`: Railcar's boarding car, the car a Table rides now, or a Table's next car. Null when no
 * Table has it (an earlier car still holds its Table).
 */
export async function findCarRide(base: Reader, rollup: Reader, match: PublicKey): Promise<CarRide | null> {
  const cfgInfo = await one(base, configPda());
  if (!cfgInfo) return null;
  const cfg = decodeConfig(cfgInfo.data);
  const keys = Array.from({ length: cfg.tables }, (_, i) => tablePda(i));
  const [live, onBase] = await Promise.all([rollup.many(keys), base.many(keys)]);
  const tables = live.map((x) => (x ? decodeTable(x.data) : null));
  const bases = onBase.map((x) => (x ? decodeTable(x.data) : null));
  const frozen = async (t: TableView | null) => !t || t.phase === "idle" || !!(await one(base, settledPda(t.tesoroMatch)));
  const rideAt = async (carNo: bigint, i: number, car: CarAccountView | null): Promise<CarRide> => ({ carNo, table: i, car, rollup: tables[i], base: bases[i], previousFrozen: await frozen(tables[i]) });
  const carAt = async (carNo: bigint) => {
    const info = await one(base, carPda(carNo));
    return info ? decodeCarAccount(info.data) : null;
  };
  if (cfg.boardingMatch.equals(match) && cfg.nextCar > 0n) {
    const carNo = cfg.nextCar - 1n;
    return rideAt(carNo, Number(carNo % BigInt(cfg.tables)), await carAt(carNo));
  }
  for (const [i, t] of tables.entries()) if (t && t.phase !== "idle" && t.tesoroMatch.equals(match)) return rideAt(t.carNo, i, await carAt(t.carNo));
  for (const [i, t] of tables.entries()) {
    if (!t) continue;
    const car = await carAt(t.nextCar);
    if (car?.tesoroMatch.equals(match)) return rideAt(t.nextCar, i, car);
  }
  return null;
}

// ---- the sweep's step ----------------------------------------------------------------------------------------------

/** One transaction the sweep sends: on base or on the rollup (the Table), with the compute it asks for. */
export interface SweepSend {
  layer: "base" | "rollup";
  what: string;
  ixs: TransactionInstruction[];
  units: number;
}

export interface SweepEnv {
  base: Reader;
  /** The rollup the Tables live on (the TEE). */
  rollup: Reader;
  core: Core;
  /** Calls and pays every step: the keeper's key. */
  caller: PublicKey;
  match: PublicKey;
  /** Unix seconds. */
  now: number;
  /** Whether one chunk instruction fits a transaction as `send` compiles it. */
  fits(ix: TransactionInstruction): boolean;
  simulate?(ix: TransactionInstruction): Promise<number | null>;
  /** Sends and waits for confirmation; throws when it fails. */
  send(s: SweepSend): Promise<void>;
}

export type SweepResult = { sent: string[] } | { wait: string };

/** The steps a car whose pages are gone needs now, sent through `env.send`; `wait` when nothing is due yet. */
export async function rideSweepStep(e: SweepEnv): Promise<SweepResult> {
  const info = await one(e.base, e.match);
  if (!info) return { sent: [] };
  const core = decodeCar(e.match, info.data);
  const ride = await findCarRide(e.base, e.rollup, e.match);
  const page = ride ? nextRideStep({ mine: { carNo: ride.carNo, table: ride.table }, core, rollup: ride.rollup, base: ride.base, previousFrozen: ride.previousFrozen, now: e.now }) : ({ kind: "wait" } as const);
  const action = sweepRideAction(page, { core, rollup: ride?.rollup ?? null, now: e.now });
  if ("wait" in action) return action;
  const sent: string[] = [];
  const send = async (s: SweepSend) => {
    await e.send(s);
    sent.push(s.what);
  };
  switch (action.send) {
    case "step-off":
      await stepEveryoneOff(e, send, ride);
      return { sent };
    case "finish":
      return finishCar(e, ride?.carNo ?? null);
    case "depart":
      await send({ layer: "base", what: "check_departure (the car held its minimum and never left)", ixs: [checkDepartureIx(ride!.carNo, e.match)], units: 200_000 });
      return { sent };
    case "start-ride": {
      if (!ride?.car) throw new Error("the car's Railcar account is gone");
      const previous = ride.rollup && ride.rollup.phase !== "idle" ? ride.rollup.tesoroMatch : null;
      await send({ layer: "rollup", what: "start_ride (the car left and nobody started its ride)", ixs: [startRideIx(e.caller, ride.car, core.pages, previous)], units: 1_000_000 });
      return { sent };
    }
    case "signal": {
      await send({ layer: "rollup", what: "signal (apply the ride's Impact)", ixs: [signalIx(e.caller, ride!.table)], units: 1_000_000 });
      if (!action.untilOver) return { sent };
      const after = await one(e.rollup, tablePda(ride!.table));
      return after && decodeTable(after.data).phase !== "over" ? { wait: "the ride has not reached its Impact yet" } : { sent };
    }
    case "commit":
      await send({ layer: "rollup", what: "commit_table (the result has not reached base)", ixs: [commitTableIx(e.caller, ride!.table)], units: 1_000_000 });
      return { sent };
  }
}

/**
 * Finishes a car with the page's finisher (reveal, finalize or core's refund, room, chunks, closes) and Railcar's Car after
 * a core refund. A Railcar car core refunded before it rode then frees its Table (`skip_car`).
 */
export async function finishCar(e: SweepEnv, carNo: bigint | null): Promise<SweepResult> {
  const ride = carNo === null ? await findCarRide(e.base, e.rollup, e.match) : null;
  const no = carNo ?? ride?.carNo ?? null;
  const sent: string[] = [];
  const result = await finishRide({
    read: e.base,
    core: e.core,
    caller: e.caller,
    carNo: no ?? 0n,
    match: e.match,
    // the sweep finishes only once base holds the ride (the page's step was finalize) or the refund time has passed
    committed: async () => true,
    fits: e.fits,
    simulate: e.simulate,
    now: e.now,
    closeRide: no !== null,
    send: async (ixs, step) => {
      await e.send({ layer: "base", what: step, ixs, units: step === "chunk" ? 300_000 : 400_000 });
      sent.push(step);
    },
    maxSends: 200,
  });
  if (!result.done && result.waiting !== "cap") throw new Error(`stalled: ${result.waiting}`);
  if (no !== null)
    await skipIfPassedOver(e, no, async (x) => {
      await e.send(x);
      sent.push(x.what);
    });
  return { sent };
}

/** The Table still waits for a car core refunded or closed before it rode: it passes the car over. */
async function skipIfPassedOver(e: SweepEnv, carNo: bigint, send: (s: SweepSend) => Promise<void>): Promise<void> {
  const [cfgInfo] = await e.base.many([configPda()]);
  if (!cfgInfo) return;
  const table = Number(carNo % BigInt(decodeConfig(cfgInfo.data).tables));
  const [t] = await e.rollup.many([tablePda(table)]);
  const view = t && decodeTable(t.data);
  if (!view || view.nextCar !== carNo || (view.phase !== "idle" && view.tesoroMatch.equals(e.match))) return;
  const [car, receipt] = await e.base.many([e.match, settledPda(e.match)]);
  if (car && !receipt) return;
  await send({ layer: "rollup", what: "skip_car (core refunded or closed the car before it rode)", ixs: [skipCarIx(e.caller, table, carNo, e.match)], units: 200_000 });
}

/**
 * A car still Boarding when core's boarding has ended: core lets anyone step a seat off then
 * (`step_off_many_seat_match`), so every seat goes home to its funder, then the empty car closes, then Railcar's Car.
 */
async function stepEveryoneOff(e: SweepEnv, send: (s: SweepSend) => Promise<void>, ride: CarRide | null): Promise<void> {
  const loaded = await loadCar(e.base, e.match);
  if (!loaded) return;
  for (const seat of loaded.seats.filter((s) => s.seated)) {
    await send({ layer: "base", what: `step_off seat ${seat.index} (boarding ended)`, ixs: [await stepOffFor(e.core, e.base, { caller: e.caller, loaded, seat })], units: 400_000 });
    for (let i = 0; i < 64; i++) {
      const ix = await returnLinesFor(e.core, e.base, { caller: e.caller, car: e.match, funder: seat.funder });
      if (!ix) break;
      await send({ layer: "base", what: `return_stepped_off seat ${seat.index}`, ixs: [ix], units: 400_000 });
    }
  }
  const after = await loadCar(e.base, e.match);
  if (after) await send({ layer: "base", what: "close_many_seat_match (every seat stepped off)", ixs: [closeCarIx(e.caller, after.car, after.pages)], units: 200_000 });
  if (ride) {
    await skipIfPassedOver(e, ride.carNo, send);
    if (ride.car) await send({ layer: "base", what: "close_car (core closed the car)", ixs: [closeRailcarCarIx(e.caller, ride.car)], units: 200_000 });
  }
}
