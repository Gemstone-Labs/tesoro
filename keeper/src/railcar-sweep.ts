import { ComputeBudgetProgram, Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  RAILCAR_PROGRAM_ID,
  carPda,
  checkDepartureIx,
  closeRailcarCarIx,
  commitTableIx,
  configPda,
  decodeCarAccount,
  decodeConfig,
  decodeTable,
  finalizeIx,
  signalIx,
  skipCarIx,
  startRideIx,
  tablePda,
  type CarAccountView,
  type TableView,
} from "../../app/src/games/railcar/chain.ts";
import { finishRide } from "../../app/src/games/railcar/finish.ts";
import { nextRideStep, type RideStep } from "../../app/src/games/railcar/flow.ts";
import { settledPda } from "../../app/src/lib/chain/basket.ts";
import { gameRecordPda, programDataPda } from "../../app/src/lib/chain/game-record.ts";
import { MAX_SEAT_CHUNK_STEPS, decodeCar, type CarView } from "../../app/src/lib/chain/many-seat.ts";
import { aheadOf, loadCar, sourcesOf } from "../../app/src/lib/chain/many-seat-plan.ts";
import { connReader, missingCutPages } from "../../app/src/lib/chain/settle-plan.ts";
import { act, type Ctx } from "./act.ts";
import { initCkptPageIx } from "./core-ix.ts";
import { bookOf } from "./kit.ts";
import { Deferred } from "./safety-sweep.ts";
import { fits, lookupTables, sendIxs } from "./send.ts";

/**
 * The safety sweep's Railcar half: the step a car's unfinished ride needs when every page has left, chosen the way a page
 * chooses it (the app's `nextRideStep`), plus what only a late sender has to weigh: core's refund once 24 h have passed, a
 * ride still inside its time, a commit still on its way. Then the finish (the app's `finishRide`) and, for a car core
 * refunded before it rode, the Table passing it over and the Car's close.
 */

/** The longest a ride runs once its draw is in (the 10-minute cap with Brakes). */
export const RIDE_CAP_SECS = 10 * 60;
/** `table_kit::COMMIT_RETRY_SECS`: a commit may be repeated this long after the last. */
export const COMMIT_RETRY_SECS = 120;

export type SweepRideAction =
  | { send: "depart" | "start-ride" | "commit" | "finalize" | "refund" }
  /** `signal`; `untilOver`: a signal that leaves the Table short of over found nothing due yet (not a try). */
  | { send: "signal"; untilOver: boolean }
  | { wait: string };

/** What the sweep weighs on top of a page's step. Pure. */
export function sweepRideAction(step: RideStep, f: { core: CarView; rollup: TableView | null; now: number }): SweepRideAction {
  if (f.core.stage === "departed" && f.now >= f.core.refundAfter && step.kind !== "finalize") return { send: "refund" };
  switch (step.kind) {
    case "depart":
    case "start-ride":
    case "finalize":
      return { send: step.kind };
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

/**
 * Finds the ride of core car `match`: Railcar's boarding car, the car a Table rides now, or a Table's next car. Null when no
 * Table has it (an earlier car still holds its Table).
 */
export async function findCarRide(base: Connection, rollup: Connection, match: PublicKey): Promise<CarRide | null> {
  const cfgInfo = await base.getAccountInfo(configPda());
  if (!cfgInfo) return null;
  const cfg = decodeConfig(cfgInfo.data);
  const indexes = Array.from({ length: cfg.tables }, (_, i) => i);
  const [live, onBase] = await Promise.all([rollup.getMultipleAccountsInfo(indexes.map(tablePda)), base.getMultipleAccountsInfo(indexes.map(tablePda))]);
  const tables = live.map((x) => (x ? decodeTable(x.data) : null));
  const bases = onBase.map((x) => (x ? decodeTable(x.data) : null));
  const frozen = async (t: TableView | null) => !t || t.phase === "idle" || !!(await base.getAccountInfo(settledPda(t.tesoroMatch)));
  const rideAt = async (carNo: bigint, i: number, car: CarAccountView | null): Promise<CarRide> => ({ carNo, table: i, car, rollup: tables[i], base: bases[i], previousFrozen: await frozen(tables[i]) });
  const carAt = async (carNo: bigint) => {
    const info = await base.getAccountInfo(carPda(carNo));
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

// ---- sending -------------------------------------------------------------------------------------------------------

const subject = (address: PublicKey) => `car=${address.toBase58().slice(0, 8)}`;

/** A rollup transaction from the keeper's key, confirmed by polling (as Block Burst's rollup sends). */
async function sendRollup(conn: Connection, ctx: Ctx, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  tx.feePayer = ctx.payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(ctx.payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`failed ${sig}: ${JSON.stringify(st.err)}`);
    if (st) return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`not confirmed ${sig}`);
}

async function step(ctx: Ctx, address: PublicKey, what: string, send: () => Promise<string>): Promise<void> {
  const r = await act(ctx, "sweep", subject(address), what, send);
  if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
  if (!r.ok) throw new Error(r.detail);
}

const rollupOf = (ctx: Ctx) => ctx.burst.teeConnection(ctx.hsigner);

/** Where a Railcar car's ride is, for the sweep's progress key (a ride step moves one of these). */
export async function rideProgress(ctx: Ctx, match: PublicKey): Promise<string> {
  const ride = await findCarRide(ctx.conn, await rollupOf(ctx), match);
  if (!ride) return "no-table";
  const t = ride.rollup;
  return `${ride.carNo}:${t ? `${t.carNo}:${t.phase}:${t.dirty ? 1 : 0}` : "-"}:${ride.base ? `${ride.base.carNo}:${ride.base.phase}` : "-"}`;
}

/** Sends the one step a Railcar car whose pages are gone needs now; throws `Deferred` when nothing is due. */
export async function railcarRideStep(ctx: Ctx, match: PublicKey): Promise<void> {
  const info = await ctx.conn.getAccountInfo(match);
  if (!info) return;
  const core = decodeCar(match, info.data);
  const rollup = await rollupOf(ctx);
  const ride = await findCarRide(ctx.conn, rollup, match);
  const page = ride ? nextRideStep({ mine: { carNo: ride.carNo, table: ride.table }, core, rollup: ride.rollup, base: ride.base, previousFrozen: ride.previousFrozen, now: ctx.now }) : ({ kind: "wait" } as const);
  const action = sweepRideAction(page, { core, rollup: ride?.rollup ?? null, now: ctx.now });
  if ("wait" in action) throw new Deferred(action.wait);
  const caller = ctx.payer.publicKey;
  const car = ride?.car;
  switch (action.send) {
    case "refund":
      return step(ctx, match, "refund_many_seat_match (24 h after departure and no result)", async () =>
        sendIxs(
          ctx.conn,
          ctx.payer,
          [await ctx.core.methods.refundManySeatMatch().accountsPartial({ caller, payer: caller, gameRecord: gameRecordPda(core.game), gameProgram: core.game, programData: programDataPda(core.game), matchState: match, receipt: settledPda(match) }).instruction()],
          { units: 300_000 },
        ),
      );
    case "depart":
      return step(ctx, match, "check_departure (the car held its minimum and never left)", () => sendIxs(ctx.conn, ctx.payer, [checkDepartureIx(ride!.carNo, match)], { units: 200_000 }));
    case "start-ride": {
      if (!car) throw new Error("the car's Railcar account is gone");
      const previous = ride!.rollup && ride!.rollup.phase !== "idle" ? ride!.rollup.tesoroMatch : null;
      return step(ctx, match, "start_ride (the car left and nobody started its ride)", () => sendRollup(rollup, ctx, [startRideIx(caller, car, core.pages, previous)]));
    }
    case "signal": {
      await step(ctx, match, "signal (apply the ride's Impact)", () => sendRollup(rollup, ctx, [signalIx(caller, ride!.table)]));
      if (!action.untilOver) return;
      const [after] = await rollup.getMultipleAccountsInfo([tablePda(ride!.table)]);
      if (after && decodeTable(after.data).phase !== "over") throw new Deferred("the ride has not reached its Impact yet");
      return;
    }
    case "commit":
      return step(ctx, match, "commit_table (the result has not reached base)", () => sendRollup(rollup, ctx, [commitTableIx(caller, ride!.table)]));
    case "finalize": {
      if (!car) throw new Error("the car's Railcar account is gone");
      const tables = await lookupTables(ctx.conn);
      return step(ctx, match, "finalize (base holds the ride's result)", () => sendIxs(ctx.conn, ctx.payer, [finalizeIx(caller, car, core.pages)], { units: 400_000, tables }));
    }
  }
}

/**
 * Finishes a car core is settling or has paid, with the app's finisher (room for winners, chunks, seat closes, the car's
 * close). A Railcar car core refunded before it rode then frees its Table (`skip_car`) and closes its Car (`close_car`).
 */
export async function finishCarOf(ctx: Ctx, match: PublicKey): Promise<void> {
  const info = await ctx.conn.getAccountInfo(match);
  if (!info) return;
  const core = decodeCar(match, info.data);
  const caller = ctx.payer.publicKey;
  const opts = { units: 400_000, tables: await lookupTables(ctx.conn) };
  if (core.stage === "settling" || core.stage === "refunding") await createCutPages(ctx, match);
  const result = await finishRide({
    read: connReader(ctx.conn),
    core: ctx.core,
    caller,
    carNo: 0n,
    match,
    committed: async () => false,
    fits: (ix) => fits(caller, [ix], opts),
    send: (ixs, what) => step(ctx, match, what, () => sendIxs(ctx.conn, ctx.payer, ixs, opts)),
    maxSends: 200,
  });
  if (!result.done && result.waiting !== "cap") throw new Error(`stalled: ${result.waiting}`);
  if (core.game.equals(RAILCAR_PROGRAM_ID)) await railcarAfterRefund(ctx, match);
}

/** Checkpoint pages a fee cut of the next chunk needs that do not exist yet: anyone may create them. */
async function createCutPages(ctx: Ctx, match: PublicKey): Promise<void> {
  const read = connReader(ctx.conn);
  const l = await loadCar(read, match);
  if (!l) return;
  for (const page of await missingCutPages(read, sourcesOf(aheadOf(l.car, l.seats, l.lines, MAX_SEAT_CHUNK_STEPS)))) {
    await step(ctx, match, `init_ckpt_page class ${page.cls} page ${page.pageNo} of ${page.source.toBase58()} before a fee cut`, async () =>
      sendIxs(ctx.conn, ctx.payer, [await initCkptPageIx(ctx.core, { payer: ctx.payer.publicKey, book: bookOf(page.source), page: page.address, cls: page.cls, pageNo: page.pageNo })], { units: 200_000 }),
    );
  }
}

/** After core froze a Railcar car that never rode: its Table passes it over and its Car closes. */
async function railcarAfterRefund(ctx: Ctx, match: PublicKey): Promise<void> {
  if (!(await ctx.conn.getAccountInfo(settledPda(match)))) return;
  const rollup = await rollupOf(ctx);
  const ride = await findCarRide(ctx.conn, rollup, match);
  if (!ride?.car) return;
  const caller = ctx.payer.publicKey;
  const t = ride.rollup;
  // The Table never took the car: it waits for it as its next car until it is passed over.
  if (t && t.nextCar === ride.carNo && !t.tesoroMatch.equals(match)) await step(ctx, match, "skip_car (core refunded the car before it rode)", () => sendRollup(rollup, ctx, [skipCarIx(caller, ride.table, ride.carNo, match)]));
  const car = ride.car;
  await step(ctx, match, "close_car (core froze the car)", () => sendIxs(ctx.conn, ctx.payer, [closeRailcarCarIx(caller, car)], { units: 200_000 }));
}
