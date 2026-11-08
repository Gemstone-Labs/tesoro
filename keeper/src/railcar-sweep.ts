import { ComputeBudgetProgram, Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { finishCar, findCarRide, rideSweepStep, type SweepEnv, type SweepSend } from "../../app/src/games/railcar/sweep.ts";
import { MAX_SEAT_CHUNK_STEPS } from "../../app/src/lib/chain/many-seat.ts";
import { aheadOf, loadCar, sourcesOf } from "../../app/src/lib/chain/many-seat-plan.ts";
import { connReader, missingCutPages, simulatedUnits } from "../../app/src/lib/chain/settle-plan.ts";
import { act, type Ctx } from "./act.ts";
import { initCkptPageIx } from "./core-ix.ts";
import { bookOf } from "./kit.ts";
import { Deferred } from "./safety-sweep.ts";
import { fits, lookupTables, sendIxs } from "./send.ts";

/**
 * The safety sweep's Railcar half: sends what the shared step (app/src/games/railcar/sweep.ts, also driven by the LiteSVM
 * rides) picks for a car whose pages are all gone, on base or on the rollup, from the keeper's key.
 */
export { COMMIT_RETRY_SECS, RIDE_CAP_SECS, sweepRideAction, type SweepRideAction } from "../../app/src/games/railcar/sweep.ts";

const subject = (address: PublicKey) => `car=${address.toBase58().slice(0, 8)}`;

/** A rollup transaction from the keeper's key, confirmed by polling (as Block Burst's rollup sends). */
async function sendRollup(conn: Connection, ctx: Ctx, ixs: TransactionInstruction[], units: number): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
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

/** The shared step's environment on the keeper's connections, sending each step through `act`. */
async function envOf(ctx: Ctx, match: PublicKey): Promise<SweepEnv> {
  const rollup = await rollupOf(ctx);
  const caller = ctx.payer.publicKey;
  const opts = { units: 400_000, tables: await lookupTables(ctx.conn) };
  return {
    base: connReader(ctx.conn),
    rollup: connReader(rollup),
    core: ctx.core,
    caller,
    match,
    now: ctx.now,
    fits: (ix) => fits(caller, [ix], opts),
    simulate: (ix) => simulatedUnits(ctx.conn, caller, [ix], opts),
    send: (s: SweepSend) => step(ctx, match, s.what, () => (s.layer === "rollup" ? sendRollup(rollup, ctx, s.ixs, s.units) : sendIxs(ctx.conn, ctx.payer, s.ixs, { ...opts, units: s.units }))),
  };
}

/** Where a Railcar car's ride is, for the sweep's progress key (a ride step moves one of these). */
export async function rideProgress(ctx: Ctx, match: PublicKey): Promise<string> {
  const ride = await findCarRide(connReader(ctx.conn), connReader(await rollupOf(ctx)), match);
  if (!ride) return "no-table";
  const t = ride.rollup;
  return `${ride.carNo}:${t ? `${t.carNo}:${t.phase}:${t.dirty ? 1 : 0}` : "-"}:${ride.base ? `${ride.base.carNo}:${ride.base.phase}` : "-"}`;
}

/** Sends the steps a Railcar car whose pages are gone needs now; throws `Deferred` when nothing is due. */
export async function railcarRideStep(ctx: Ctx, match: PublicKey): Promise<void> {
  const r = await rideSweepStep(await envOf(ctx, match));
  if ("wait" in r) throw new Deferred(r.wait);
}

/**
 * Finishes a car core is settling or has paid, with the app's finisher (room for winners, chunks, seat closes, the car's
 * close) and, for a Railcar car core refunded before it rode, its Table passing it over and its Car's close.
 */
export async function finishCarOf(ctx: Ctx, match: PublicKey): Promise<void> {
  const info = await ctx.conn.getAccountInfo(match);
  if (!info) return;
  await createCutPages(ctx, match);
  await finishCar(await envOf(ctx, match), null);
}

/** Checkpoint pages a fee cut of the next chunk needs that do not exist yet: anyone may create them. */
async function createCutPages(ctx: Ctx, match: PublicKey): Promise<void> {
  const read = connReader(ctx.conn);
  const l = await loadCar(read, match);
  if (!l || (l.car.stage !== "settling" && l.car.stage !== "refunding")) return;
  for (const page of await missingCutPages(read, sourcesOf(aheadOf(l.car, l.seats, l.lines, MAX_SEAT_CHUNK_STEPS)))) {
    await step(ctx, match, `init_ckpt_page class ${page.cls} page ${page.pageNo} of ${page.source.toBase58()} before a fee cut`, async () =>
      sendIxs(ctx.conn, ctx.payer, [await initCkptPageIx(ctx.core, { payer: ctx.payer.publicKey, book: bookOf(page.source), page: page.address, cls: page.cls, pageNo: page.pageNo })], { units: 200_000 }),
    );
  }
}
