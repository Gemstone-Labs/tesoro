import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { canFinalizeTable as burstCanFinalize } from "../../app/src/games/block-puzzle/live-chain.ts";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { HOLDEM_PROGRAM_ID, canFinalizeTable as holdemCanFinalize } from "../../app/src/games/holdem/chain.ts";
import { TRADING_DUEL_PROGRAM_ID, canFinalizeTable as duelCanFinalize } from "../../app/src/games/trading-duel/chain.ts";
import { VANGUARD_PROGRAM_ID } from "../../app/src/games/vanguard/chain.ts";
import { canFinalizeTable as vanguardCanFinalize } from "../../app/src/games/vanguard/chain.ts";
import { finishMatch, type FinishDeps, type Planned, type Progress } from "../../app/src/lib/chain/finish-match.ts";
import { CHUNK_STEPS, CHUNK_UNITS, closeIx, connReader, loadMatch, missingCutPages, planSizedChunk, runOf, sourcesAhead, viewOf, type MatchView } from "../../app/src/lib/chain/settle-plan.ts";
import { act, finalizeOrRaced, log, type Ctx } from "./act.ts";
import { makeScanRpc, scanProgramAccounts, type ScanRpc } from "./credits.ts";
import { CORE_ID, bookOf } from "./kit.ts";
import { discriminatorOf } from "./lists.ts";
import { initCkptPageIx, refundMatchIx } from "./core-ix.ts";
import { solanaFetch } from "./runtime.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { historyRpc } from "./history.ts";
import { Deferred, SLICE_LEN, anyHeadOf, carHeadAt, headOf, type Head, type SweepDeps } from "./safety-sweep.ts";
import { RAILCAR_PROGRAM_ID, nextRideStep, PHASE, type RailcarChain } from "../../app/src/games/railcar/chain.ts";
import { MAX_SEAT_CHUNK_STEPS, carMissingCutPages, carProgress, decodeCar, finishCar, isCar, loadCar, nextCarStep, receiptPda, refundCarIx, type LoadedCar } from "../../app/src/lib/chain/many-seat-plan.ts";
import { programDataPda } from "../../app/src/lib/chain/game-record.ts";
import { compile, fits, lookupTables, sendIxs } from "./send.ts";

/** The chain of each Game the sweep can finalize: its Assignment, base's committed copy of the Table, and `finalize`. */
function gameOf(ctx: Ctx, game: PublicKey) {
  const adapters = [
    { id: BLOCK_PUZZLE_PROGRAM_ID, chain: ctx.burst, canFinalize: burstCanFinalize },
    { id: HOLDEM_PROGRAM_ID, chain: ctx.holdem, canFinalize: holdemCanFinalize },
    { id: TRADING_DUEL_PROGRAM_ID, chain: ctx.duel, canFinalize: duelCanFinalize },
    { id: VANGUARD_PROGRAM_ID, chain: ctx.vanguard, canFinalize: vanguardCanFinalize },
  ] as unknown as { id: PublicKey; chain: any; canFinalize(base: any, a: any, now: number): boolean }[];
  return adapters.find((g) => g.id.equals(game)) ?? null;
}

/** Where a Match is: its stage and the cursor of its run (a chunk that landed moves it). */
const progressOf = (v: MatchView): Progress => {
  const run = runOf(v.inner.run);
  return { stage: v.stage, phase: run?.phaseI ?? 0, line: run?.lineI ?? 0 };
};

const fetchView = async (ctx: Ctx, address: PublicKey): Promise<MatchView | null> => {
  const account = await ctx.core.account.matchState.fetchNullable(address);
  return account ? viewOf(address, account) : null;
};

/** What the shared finisher (`finishMatch`) reaches the chain through, sending with the keeper's key. */
export function finishDeps(ctx: Ctx, subject: (address: PublicKey) => string): FinishDeps {
  const read = connReader(ctx.conn);
  const caller = ctx.payer.publicKey;
  const views = new Map<string, MatchView>();
  let current: PublicKey | null = null;
  return {
    fetch: async (address) => {
      const view = await fetchView(ctx, address);
      if (!view) return null;
      views.set(address.toBase58(), view);
      return progressOf(view);
    },
    plan: async (_progress, address): Promise<Planned> => {
      current = address;
      const view = views.get(address.toBase58());
      if (!view) return { kind: "stalled", reason: "unread" };
      const loaded = await loadMatch(read, view);
      const tables = await lookupTables(ctx.conn);
      if (view.stage === "closed") return { kind: "close", ix: await closeIx(ctx.core, read, caller, loaded) };
      const run = runOf(view.inner.run);
      if (!loaded.stores[0] || !run) return { kind: "stalled", reason: "no-run" };
      // A fee cut can need a checkpoint page that does not exist yet; anyone may create it.
      for (const page of await missingCutPages(read, sourcesAhead(run, loaded.stores, CHUNK_STEPS))) {
        const r = await act(ctx, "sweep", subject(address), `init_ckpt_page class ${page.cls} page ${page.pageNo} of ${page.source.toBase58()} before a fee cut`, async () =>
          sendIxs(ctx.conn, ctx.payer, [await initCkptPageIx(ctx.core, { payer: caller, book: bookOf(page.source), page: page.address, cls: page.cls, pageNo: page.pageNo })], { units: 200_000 }),
        );
        if (!r.ok) return { kind: "stalled", reason: "needs-page" };
      }
      const opts = { units: CHUNK_UNITS, tables };
      const plan = await planSizedChunk(
        {
          core: ctx.core,
          read,
          caller,
          fitsOne: (ix) => fits(caller, [ix], opts),
          simulate: async (ix: TransactionInstruction) => {
            try {
              const { blockhash } = await ctx.conn.getLatestBlockhash();
              const tx = compile(caller, blockhash, [ix], opts);
              tx.sign([ctx.payer]);
              return (await ctx.conn.simulateTransaction(tx, { sigVerify: false })).value.unitsConsumed ?? null;
            } catch {
              return null;
            }
          },
        },
        loaded,
      );
      if (!plan) return { kind: "stalled", reason: "no-run" };
      if (plan.missing.length) return { kind: "stalled", reason: "missing-book" };
      return { kind: "chunk", ix: plan.ix };
    },
    send: async (step) => {
      const tables = await lookupTables(ctx.conn);
      const opts = step.kind === "chunk" ? { units: CHUNK_UNITS, tables } : { units: 200_000, tables };
      const what = step.kind === "chunk" ? "match_chunk" : "close_match";
      let sig = "";
      const r = await act(ctx, "sweep", current ? subject(current) : "", what, async () => (sig = await sendIxs(ctx.conn, ctx.payer, [step.ix], opts)));
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok) throw new Error(r.detail);
      return sig;
    },
  };
}

/** Addresses per getMultipleAccounts call (the RPC limit is 100). */
const READ_BATCH = 100;

/** The Match accounts the webhook-fed `open_match` table says are not closed yet (migration 0024). */
export async function dbMatches(db: Rpc): Promise<PublicKey[]> {
  const rows = (await db("open_match_sweep_candidates", {})) as string[] | null;
  if (!Array.isArray(rows)) throw new Error("open_match_sweep_candidates returned no list");
  return rows.map((r) => new PublicKey(r));
}

/** Tells `open_match` these accounts are closed on chain, so later runs stop reading them. */
export async function markGone(db: Rpc, addresses: PublicKey[]): Promise<void> {
  if (addresses.length) await db("open_match_account_gone", { p_match_states: addresses.map((a) => a.toBase58()) });
}

/** Reads Match heads by address (a sliced `getMultipleAccounts`, 1 credit per 100); accounts that are missing or not Matches are `gone`. */
export async function readHeadsByAddress(rpc: Pick<ScanRpc, "call">, addresses: PublicKey[]): Promise<{ heads: Head[]; gone: PublicKey[] }> {
  const heads: Head[] = [];
  const gone: PublicKey[] = [];
  for (let i = 0; i < addresses.length; i += READ_BATCH) {
    const batch = addresses.slice(i, i + READ_BATCH);
    const res = await rpc.call("getMultipleAccounts", [batch.map((a) => a.toBase58()), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: SLICE_LEN } }]);
    const value = res.value as ({ data: [string, string] } | null)[];
    batch.forEach((address, j) => {
      const row = value[j];
      // A car is not a MatchState, and must not be told to the database as gone.
      const head = row ? anyHeadOf(address, Buffer.from(row.data[0], "base64")) : null;
      if (head) heads.push(head);
      else gone.push(address);
    });
  }
  return { heads, gone };
}

/** The sweep over the real chain. Matches are found with a sliced, paged scan on the base layer. */
export function realSweepDeps(ctx: Ctx, env: NodeJS.ProcessEnv = process.env): SweepDeps {
  const gpa = new Connection(ctx.settings.gpaRpc, { commitment: "confirmed", fetch: solanaFetch, disableRetryOnRateLimit: true });
  const rpc = makeScanRpc(ctx.settings.gpaRpc, solanaFetch, (p, c) => gpa.getProgramAccounts(p, c as any) as any);
  const subject = (address: PublicKey) => `match=${address.toBase58().slice(0, 8)}`;
  const finisher = finishDeps(ctx, subject);
  const db = historyRpc(env);
  if (!db) log("sweep", "-", "no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: every run scans the chain");

  // The spend cap needs the balance before the first send, not on a run that sends nothing.
  let observed = false;
  const observeBalance = async () => {
    if (observed) return;
    observed = true;
    ctx.budget.observe(await ctx.conn.getBalance(ctx.payer.publicKey));
  };

  return {
    ...(db && {
      dbMatches: () => dbMatches(db),
      readHeads: (addresses: PublicKey[]) => readHeadsByAddress(rpc, addresses),
      markGone: (addresses: PublicKey[]) => markGone(db, addresses),
    }),
    scan: async () => {
      const rowsOf = (name: string) => scanProgramAccounts(rpc, CORE_ID, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf(name)) } }], dataSlice: { offset: 0, length: SLICE_LEN } });
      const matches = (await rowsOf("MatchState")).map((r) => headOf(r.pubkey, r.account.data));
      const cars = (await rowsOf("ManySeatMatch")).map((r) => carHeadAt(r.pubkey, r.account.data));
      return [...matches, ...cars].filter((h): h is Head => !!h);
    },
    committed: async (head) => {
      const game = gameOf(ctx, head.game);
      if (!game) return false;
      const a = await game.chain.readAssignment(head.address);
      // A failed read throws: the sweep must not read it as "no result" and refund a Match whose result is committed.
      const base = a ? await game.chain.readTableOnBase(a) : null;
      return !!a && !!base && game.canFinalize(base, a, ctx.now);
    },
    progress: async (address) => {
      const info = await ctx.conn.getAccountInfo(address);
      if (info && isCar(info.data)) return carProgressKey(ctx, address, info.data);
      const view = await fetchView(ctx, address);
      if (!view) return null;
      const p = progressOf(view);
      return `${p.stage}:${p.phase}:${p.line}`;
    },
    finalize: async (head) => {
      await observeBalance();
      const game = gameOf(ctx, head.game);
      if (!game) throw new Error(`unknown game ${head.game.toBase58()}`);
      const a = await game.chain.readAssignment(head.address);
      if (!a) throw new Error("no Assignment");
      const r = await act(ctx, "sweep", subject(head.address), "finalize (the committed table holds the result)", () => finalizeOrRaced(game.chain, ctx.hsigner, a));
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok && r.detail !== "raced") throw new Error(r.detail);
    },
    finish: async (address) => {
      await observeBalance();
      const info = await ctx.conn.getAccountInfo(address);
      if (info && isCar(info.data)) return finishRailcarCar(ctx, address, decodeCar(address, info.data).game);
      const result = await finishMatch(finisher, address);
      if (result.stalled && result.stalled !== "step-limit") throw new Error(`stalled: ${result.stalled}`);
    },
    ride: async (head) => {
      await observeBalance();
      if (!head.game.equals(RAILCAR_PROGRAM_ID)) throw new Error(`no ride adapter for game ${head.game.toBase58()}`);
      await railcarRideStep(ctx, head.address);
    },
    refund: async (head) => {
      await observeBalance();
      const r = await act(ctx, "sweep", subject(head.address), "refund_match (a Backer funded it and nobody joined before the deadline)", async () =>
        sendIxs(ctx.conn, ctx.payer, [await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: head.game, matchState: head.address })], { units: 300_000 }),
      );
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok && r.detail !== "raced") throw new Error(r.detail);
    },
  };
}


// ---- many-seat cars (Railcar) -------------------------------------------------------------------------------------

const carSubject = (address: PublicKey) => `car=${address.toBase58().slice(0, 8)}`;

/** A send through `act` (spend cap, dry run, log); a refused send throws, a spend cap defers. */
async function sendStep(ctx: Ctx, address: PublicKey, what: string, send: () => Promise<string>): Promise<void> {
  const r = await act(ctx, "sweep", carSubject(address), what, send);
  if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
  if (!r.ok) throw new Error(r.detail);
}

/** Where a car is: core's stage, run and seats, and while it rides its Table's phase (a ride step moves one of them). */
async function carProgressKey(ctx: Ctx, address: PublicKey, data: Buffer): Promise<string> {
  const car = decodeCar(address, data);
  const key = `car:${carProgress(car)}`;
  if (car.stage !== "departed" || !car.game.equals(RAILCAR_PROGRAM_ID)) return key;
  const ride = await ctx.railcar.findRide(ctx.hsigner, address);
  return ride ? `${key}:${ride.table.carNo}:${ride.table.phase}:${ride.table.dirty ? 1 : 0}:${ride.baseTable?.phase ?? "-"}` : `${key}:no-table`;
}

/** The one step an unfinished Railcar ride needs (`nextRideStep`), sent the way a page sends it. */
export async function railcarRideStep(ctx: Ctx, address: PublicKey): Promise<void> {
  const chain: RailcarChain = ctx.railcar;
  const l = await loadCar(connReader(ctx.conn), address);
  if (!l) return;
  const caller = ctx.payer.publicKey;
  const ride = l.car.stage === "departed" ? await chain.findRide(ctx.hsigner, address) : null;
  const slot = BigInt(await (await chain.teeConnection(ctx.hsigner)).getSlot("confirmed"));
  const plan = nextRideStep({ coreCar: l.car, ride, slot, now: ctx.now });
  if ("wait" in plan) throw new Deferred(plan.wait);
  const table = ride?.table.address;
  switch (plan.step) {
    case "check_departure": {
      const car = await chain.boardingCar(address);
      if (!car) throw new Error("the car is not Railcar's boarding car");
      return sendStep(ctx, address, "check_departure (the car held its minimum and never left)", async () => sendIxs(ctx.conn, ctx.payer, [await chain.checkDepartureIx(car)], { units: 200_000 }));
    }
    case "start_ride":
      return sendStep(ctx, address, "start_ride (the car left and nobody started its ride)", async () => chain.sendRollup(ctx.hsigner, [await chain.startRideIx(caller, ride!.car!, l.car, ride!.table)]));
    case "signal":
      return sendStep(ctx, address, "signal (the ride is past its time: apply the Impact)", async () => chain.sendRollup(ctx.hsigner, [await chain.signalIx(caller, table!)]));
    case "signal_then_check": {
      await sendStep(ctx, address, "signal (the ride may be past its Impact)", async () => chain.sendRollup(ctx.hsigner, [await chain.signalIx(caller, table!)]));
      const after = await chain.findRide(ctx.hsigner, address);
      if (after?.table.phase === PHASE.riding) throw new Deferred("the ride has not reached its Impact yet");
      return;
    }
    case "commit_table":
      return sendStep(ctx, address, "commit_table (the result has not reached base)", async () => chain.sendRollup(ctx.hsigner, [await chain.commitTableIx(caller, table!)]));
    case "finalize":
      return sendStep(ctx, address, "finalize (base holds the ride's result)", async () => sendIxs(ctx.conn, ctx.payer, [await chain.finalizeIx(caller, ride!.car!, l.car)], { units: 400_000, tables: await lookupTables(ctx.conn) }));
    case "refund":
      return sendStep(ctx, address, "refund_many_seat_match (24 h after departure and no result)", async () =>
        sendIxs(ctx.conn, ctx.payer, [await refundCarIx(ctx.core, { caller, car: l.car, programData: programDataPda(l.car.game) })], { units: 300_000 }),
      );
  }
}

/**
 * Finishes a car core is settling or has paid: chunks, each seat's close, the car's close. A Railcar car core refunded
 * without a ride then frees its Table (`skip_car`) and gives its Car's rent back (`close_car`).
 */
async function finishRailcarCar(ctx: Ctx, address: PublicKey, game: PublicKey): Promise<void> {
  const read = connReader(ctx.conn);
  const caller = ctx.payer.publicKey;
  const tables = await lookupTables(ctx.conn);
  const opts = { units: CHUNK_UNITS, tables };
  const result = await finishCar(
    {
      load: (a) => loadCar(read, a),
      next: async (l: LoadedCar) => {
        // A fee cut can need a checkpoint page that does not exist yet; anyone may create it.
        if (l.car.stage === "settling" || l.car.stage === "refunding") {
          for (const page of await carMissingCutPages(ctx.core, read, l, MAX_SEAT_CHUNK_STEPS)) {
            const r = await act(ctx, "sweep", carSubject(address), `init_ckpt_page class ${page.cls} page ${page.pageNo} of ${page.source.toBase58()} before a fee cut`, async () =>
              sendIxs(ctx.conn, ctx.payer, [await initCkptPageIx(ctx.core, { payer: caller, book: bookOf(page.source), page: page.address, cls: page.cls, pageNo: page.pageNo })], { units: 200_000 }),
            );
            if (!r.ok) return { kind: "stalled", reason: "needs-page" };
          }
        }
        return nextCarStep(ctx.core, read, caller, l, { steps: MAX_SEAT_CHUNK_STEPS, fitsOne: (ix) => fits(caller, [ix], opts) });
      },
      send: async (step) => {
        let sig = "";
        const r = await act(ctx, "sweep", carSubject(address), step.kind, async () => (sig = await sendIxs(ctx.conn, ctx.payer, [step.ix], opts)));
        if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
        if (!r.ok) throw new Error(r.detail);
        return sig;
      },
    },
    address,
  );
  if (game.equals(RAILCAR_PROGRAM_ID)) await railcarAfterRefund(ctx, address);
  if (!result.done && result.stalled !== "step-limit") throw new Error(`stalled: ${result.stalled}`);
}

/** After core froze a Railcar car that never rode: its Table passes it over and its Car closes. */
async function railcarAfterRefund(ctx: Ctx, address: PublicKey): Promise<void> {
  const [receipt] = await ctx.conn.getMultipleAccountsInfo([receiptPda(address)]);
  if (!receipt) return;
  const ride = await ctx.railcar.findRide(ctx.hsigner, address);
  if (!ride?.car) return;
  const caller = ctx.payer.publicKey;
  const car = ride.car;
  // The Table never took the car: it waits for it as its next car until it is passed over.
  if (ride.table.nextCar === car.carNo && !ride.table.tesoroMatch.equals(address))
    await sendStep(ctx, address, "skip_car (core refunded the car before it rode)", async () => ctx.railcar.sendRollup(ctx.hsigner, [await ctx.railcar.skipCarIx(caller, ride.table, car.address, address)]));
  await sendStep(ctx, address, "close_car (core froze the car)", async () => sendIxs(ctx.conn, ctx.payer, [await ctx.railcar.closeCarIx(caller, car)], { units: 200_000 }));
}
