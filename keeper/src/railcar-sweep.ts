import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { RAILCAR_PROGRAM_ID, decodeCarAccount } from "../../app/src/games/railcar/chain.ts";
import { finishCar, findCarRide, reconcileTables, rideSweepStep, type CarReader, type Reconciled, type SweepEnv, type SweepSend } from "../../app/src/games/railcar/sweep.ts";
import { connReader, simulatedUnits } from "../../app/src/lib/chain/settle-plan.ts";
import { act, log, type Ctx } from "./act.ts";
import { createHash } from "node:crypto";
import { scanProgramAccounts, type ScanRpc } from "./credits.ts";
import { Deferred } from "./safety-sweep.ts";
import { fits, lookupTables, sendIxs } from "./send.ts";

/** `Car.tesoro_match` sits after the discriminator, `bump` and `car_no`. */
const CAR_MATCH_OFFSET = 8 + 1 + 8;
/** Anchor's discriminator of Railcar's `Car` account. */
const CAR_DISCRIMINATOR = createHash("sha256").update("account:Car").digest().subarray(0, 8);

/**
 * The base reader for the sweep: accounts by address, and Railcar's Car for a core Match in one program scan (paged on
 * Helius, plain `getProgramAccounts` elsewhere; a Car is 94 bytes, so the scan is small).
 */
export function carReader(conn: Connection, rpc?: ScanRpc): CarReader {
  const plain = connReader(conn);
  if (!rpc) return plain;
  const isCar = { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(CAR_DISCRIMINATOR) } };
  const rows = (filters: typeof isCar[]) => scanProgramAccounts(rpc, RAILCAR_PROGRAM_ID, { filters });
  return {
    ...plain,
    carByMatch: async (match) => {
      const row = (await rows([isCar, { memcmp: { offset: CAR_MATCH_OFFSET, bytes: match.toBase58() } }]))[0];
      return row ? { carNo: decodeCarAccount(row.account.data).carNo, data: row.account.data } : null;
    },
    openCars: async () => (await rows([isCar])).map((row) => ({ carNo: decodeCarAccount(row.account.data).carNo, data: row.account.data })),
  };
}

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
async function envOf(ctx: Ctx, match: PublicKey, rpc?: ScanRpc): Promise<SweepEnv> {
  const rollup = await rollupOf(ctx);
  const caller = ctx.payer.publicKey;
  const opts = { units: 400_000, tables: await lookupTables(ctx.conn) };
  return {
    base: carReader(ctx.conn, rpc),
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
export async function rideProgress(ctx: Ctx, match: PublicKey, rpc?: ScanRpc): Promise<string> {
  const ride = await findCarRide(carReader(ctx.conn, rpc), connReader(await rollupOf(ctx)), match);
  if (!ride) return "no-table";
  const t = ride.rollup;
  return `${ride.carNo}:${t ? `${t.carNo}:${t.phase}:${t.dirty ? 1 : 0}` : "-"}:${ride.base ? `${ride.base.carNo}:${ride.base.phase}` : "-"}`;
}

/** Sends the steps a Railcar car whose pages are gone needs now; throws `Deferred` when nothing is due. */
export async function railcarRideStep(ctx: Ctx, match: PublicKey, rpc?: ScanRpc): Promise<void> {
  const r = await rideSweepStep(await envOf(ctx, match, rpc));
  if ("wait" in r) throw new Deferred(r.wait);
}

/**
 * Finishes a car core is settling or has paid, with the app's finisher (room for winners, the checkpoint pages a fee cut
 * needs, chunks, seat closes, the car's close) and, for a Railcar car core refunded before it rode, its Table passing it
 * over and its Car's close.
 */
export async function finishCarOf(ctx: Ctx, match: PublicKey, rpc?: ScanRpc): Promise<void> {
  const info = await ctx.conn.getAccountInfo(match);
  if (!info) return;
  await finishCar(await envOf(ctx, match, rpc), null);
}

/**
 * The Cars and each Table's next car judged on their own (`reconcileTables`): a car core refunded or closed before it rode
 * has its Car closed, then its Table passes it over. A failed close is logged; the next sweep tries again.
 */
export async function reconcileRailcarTables(ctx: Ctx, rpc?: ScanRpc): Promise<Reconciled> {
  const rollup = await rollupOf(ctx);
  const r = await reconcileTables({
    base: carReader(ctx.conn, rpc),
    rollup: connReader(rollup),
    caller: ctx.payer.publicKey,
    send: (s) => step(ctx, RAILCAR_PROGRAM_ID, s.what, () => (s.layer === "rollup" ? sendRollup(rollup, ctx, s.ixs, s.units) : sendIxs(ctx.conn, ctx.payer, s.ixs, { units: s.units }))),
  });
  if (r.failed.length) log("sweep", "railcar", `Car close failed for car(s) ${r.failed.join(", ")}: their Tables wait; next sweep`);
  return r;
}

