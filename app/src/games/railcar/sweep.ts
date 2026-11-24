/**
 * The keeper safety sweep's Railcar half, as one function the keeper sends through and the LiteSVM rides drive: for a car
 * whose pages are all gone, the steps a page would have taken (`nextRideStep`), plus what only a late sender weighs: core's
 * refund once the car's refund time has passed, a ride still inside its time, a commit on its way, and a car still
 * Boarding when core's boarding has ended (nobody can join or depart it any more, so every seat steps off home and the
 * car closes), and a seat in a car still Boarding whose Player has since started a Break or Self-Exclusion (core lets anyone
 * step that seat off; the Player's own page steps them off as they start it, so this is the backstop). The finish goes
 * through `finishRide`, as a page's does. Reads only; `send` sends.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { settledPda } from "../../lib/chain/basket";
import { isAwayAt } from "../../lib/chain/away-plan";
import { boardingEnds, closeCarIx, decodeCar, type CarView, type SeatView } from "../../lib/chain/many-seat";
import { loadCar, type LoadedCar } from "../../lib/chain/many-seat-plan";
import { protectionsPda } from "../../lib/chain/native";
import type { Core, Info, Reader } from "../../lib/chain/settle-plan";
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
    case "refund":
      return { send: "finish" };
    case "skip":
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
  /** Core's receipt for the car the Table holds exists (false for an idle Table). */
  previousReceipt: boolean;
}

const one = async (read: Reader, key: PublicKey) => (await read.many([key]))[0];

/** A base reader that can also find Railcar's Car for a core Match in one query (the keeper's program scan). */
export interface CarReader extends Reader {
  carByMatch?(match: PublicKey): Promise<{ carNo: bigint; info: Info } | null>;
}

/**
 * The Car opened for core car `match`, whatever Table it is on: the reader's own lookup when it has one, else every car
 * opened so far read from the newest down (100 a query), with no cutoff: a car's Car outlives its Table's interest in it.
 */
export async function carByMatch(base: CarReader, nextCar: bigint, match: PublicKey): Promise<{ carNo: bigint; car: CarAccountView } | null> {
  if (base.carByMatch) {
    const found = await base.carByMatch(match);
    return found && { carNo: found.carNo, car: decodeCarAccount(found.info.data) };
  }
  for (let top = nextCar; top > 0n; top -= 100n) {
    const nos = Array.from({ length: Number(top < 100n ? top : 100n) }, (_, k) => top - 1n - BigInt(k));
    const infos = await base.many(nos.map(carPda));
    for (const [k, info] of infos.entries()) {
      const car = info ? decodeCarAccount(info.data) : null;
      if (car?.tesoroMatch.equals(match)) return { carNo: nos[k], car };
    }
  }
  return null;
}

/**
 * Finds the ride of core car `match`: Railcar's boarding car, the car a Table rides now, a Table's next car, or (its Table
 * having moved on to a later car) the Car opened for it (`carByMatch`). Null when no Table has it and no Car names it.
 */
export async function findCarRide(base: CarReader, rollup: Reader, match: PublicKey): Promise<CarRide | null> {
  const cfgInfo = await one(base, configPda());
  if (!cfgInfo) return null;
  const cfg = decodeConfig(cfgInfo.data);
  const keys = Array.from({ length: cfg.tables }, (_, i) => tablePda(i));
  const [live, onBase] = await Promise.all([rollup.many(keys), base.many(keys)]);
  const tables = live.map((x) => (x ? decodeTable(x.data) : null));
  const bases = onBase.map((x) => (x ? decodeTable(x.data) : null));
  const receiptOf = async (t: TableView | null) => !!t && t.phase !== "idle" && !!(await one(base, settledPda(t.tesoroMatch)));
  const rideAt = async (carNo: bigint, i: number, car: CarAccountView | null): Promise<CarRide> => ({ carNo, table: i, car, rollup: tables[i], base: bases[i], previousReceipt: await receiptOf(tables[i]) });
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
  const found = await carByMatch(base, cfg.nextCar, match);
  return found ? rideAt(found.carNo, Number(found.carNo % BigInt(cfg.tables)), found.car) : null;
}

/**
 * Each Table's next car, judged on its own (not from an open core Match, which a page may have refunded and closed without
 * `skip_car`): a car core refunded, settled or closed before it rode is passed over, and its Car closed. A car still
 * boarding, departed and waiting, or not opened yet is left alone. Returns the cars skipped.
 */
export async function reconcileTables(e: Pick<SweepEnv, "base" | "rollup" | "caller" | "send">): Promise<{ skipped: bigint[] }> {
  const skipped: bigint[] = [];
  const cfgInfo = await one(e.base, configPda());
  if (!cfgInfo) return { skipped };
  const cfg = decodeConfig(cfgInfo.data);
  const tables = (await e.rollup.many(Array.from({ length: cfg.tables }, (_, i) => tablePda(i)))).map((x) => (x ? decodeTable(x.data) : null));
  for (const [i, t] of tables.entries()) {
    if (!t || t.nextCar >= cfg.nextCar) continue;
    const carInfo = await one(e.base, carPda(t.nextCar));
    const car = carInfo ? decodeCarAccount(carInfo.data) : null;
    if (car) {
      const [match, receipt] = await e.base.many([car.tesoroMatch, settledPda(car.tesoroMatch)]);
      if (match && !receipt) continue;
      await e.send({ layer: "rollup", what: `skip_car ${t.nextCar} (core refunded or closed it before it rode; its Table waited for it)`, ixs: [skipCarIx(e.caller, i, t.nextCar, car.tesoroMatch)], units: 200_000 });
      await e.send({ layer: "base", what: `close_car ${t.nextCar} (core froze or closed it)`, ixs: [closeRailcarCarIx(e.caller, { ...car, carNo: t.nextCar })], units: 200_000 });
    } else {
      // The Car is closed already (core froze or closed its Match): the Table only needs to move on.
      await e.send({ layer: "rollup", what: `skip_car ${t.nextCar} (its Car is closed; its Table waited for it)`, ixs: [skipCarIx(e.caller, i, t.nextCar, PublicKey.default)], units: 200_000 });
    }
    skipped.push(t.nextCar);
  }
  return { skipped };
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
  base: CarReader;
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

/** The seated seats whose Player is on a Break or Self-Excluded at `now` (their Protections accounts read from `read`). */
export async function awaySeats(read: Reader, seats: SeatView[], now: number): Promise<SeatView[]> {
  const seated = seats.filter((s) => s.seated);
  if (!seated.length) return [];
  const protections = await read.many(seated.map((s) => protectionsPda(s.player)));
  return seated.filter((_, i) => isAwayAt(protections[i]?.data, now));
}

/** The steps a car whose pages are gone needs now, sent through `env.send`; `wait` when nothing is due yet. */
export async function rideSweepStep(e: SweepEnv): Promise<SweepResult> {
  const info = await one(e.base, e.match);
  if (!info) return { sent: [] };
  const core = decodeCar(e.match, info.data);
  const sent: string[] = [];
  const send = async (s: SweepSend) => {
    await e.send(s);
    sent.push(s.what);
  };
  // A car still taking seats: whoever has started a Break or Self-Exclusion since boarding steps off first, before it can leave.
  if (core.stage === "boarding" && e.now < boardingEnds(core)) {
    const loaded = await loadCar(e.base, e.match);
    const away = loaded ? await awaySeats(e.base, loaded.seats, e.now) : [];
    for (const seat of away) await stepSeatOff(e, send, loaded!, seat, "the Player is away");
    if (away.length) return { sent };
  }
  const ride = await findCarRide(e.base, e.rollup, e.match);
  const page = ride ? nextRideStep({ mine: { carNo: ride.carNo, table: ride.table }, core, rollup: ride.rollup, base: ride.base, previousReceipt: ride.previousReceipt, now: e.now }) : ({ kind: "wait" } as const);
  const action = sweepRideAction(page, { core, rollup: ride?.rollup ?? null, now: e.now });
  if ("wait" in action) return action;
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
  if (!result.done && result.waiting !== "cap") throw new Error(`stalled: ${result.waiting} after ${result.sent.join(", ") || "nothing"}`);
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
  for (const seat of loaded.seats.filter((s) => s.seated)) await stepSeatOff(e, send, loaded, seat, "boarding ended");
  const after = await loadCar(e.base, e.match);
  if (after) await send({ layer: "base", what: "close_many_seat_match (every seat stepped off)", ixs: [closeCarIx(e.caller, after.car, after.pages)], units: 200_000 });
  if (ride) {
    await skipIfPassedOver(e, ride.carNo, send);
    if (ride.car) await send({ layer: "base", what: "close_car (core closed the car)", ixs: [closeRailcarCarIx(e.caller, ride.car)], units: 200_000 });
  }
}

/** One seat home to its funder: core's step-off, then whatever lines it left on their way. */
async function stepSeatOff(e: SweepEnv, send: (s: SweepSend) => Promise<void>, loaded: LoadedCar, seat: SeatView, why: string): Promise<void> {
  await send({ layer: "base", what: `step_off seat ${seat.index} (${why})`, ixs: [await stepOffFor(e.core, e.base, { caller: e.caller, loaded, seat })], units: 400_000 });
  for (let i = 0; i < 64; i++) {
    const ix = await returnLinesFor(e.core, e.base, { caller: e.caller, car: e.match, funder: seat.funder });
    if (!ix) break;
    await send({ layer: "base", what: `return_stepped_off seat ${seat.index}`, ixs: [ix], units: 400_000 });
  }
}
