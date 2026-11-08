import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { canFinalizeTable as burstCanFinalize } from "../../app/src/games/block-puzzle/live-chain.ts";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { HOLDEM_PROGRAM_ID, canFinalizeTable as holdemCanFinalize } from "../../app/src/games/holdem/chain.ts";
import { TRADING_DUEL_PROGRAM_ID, canFinalizeTable as duelCanFinalize } from "../../app/src/games/trading-duel/chain.ts";
import { VANGUARD_PROGRAM_ID } from "../../app/src/games/vanguard/chain.ts";
import { canFinalizeTable as vanguardCanFinalize } from "../../app/src/games/vanguard/chain.ts";
import { finishMatch, type FinishDeps, type Planned, type Progress } from "../../app/src/lib/chain/finish-match.ts";
import { CHUNK_STEPS, CHUNK_UNITS, closeIx, connReader, loadMatch, missingCutPages, planSizedChunk, runOf, simulatedUnits, sourcesAhead, viewOf, type MatchView } from "../../app/src/lib/chain/settle-plan.ts";
import { untabledRefundDue } from "../../app/src/lib/chain/match-status.ts";
import { Raced, act, finalizeOrRaced, log, type Ctx } from "./act.ts";
import { makeScanRpc, scanProgramAccounts, type ScanRpc } from "./credits.ts";
import { CORE_ID, bookOf } from "./kit.ts";
import { discriminatorOf } from "./lists.ts";
import { initCkptPageIx, refundMatchIx } from "./core-ix.ts";
import { solanaFetch } from "./runtime.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { historyRpc } from "./history.ts";
import { Deferred, SLICE_LEN, anyHeadOf, carHeadAt, headOf, type Head, type SweepDeps } from "./safety-sweep.ts";
import { RAILCAR_PROGRAM_ID } from "../../app/src/games/railcar/chain.ts";
import { decodeCar } from "../../app/src/lib/chain/many-seat.ts";
import { finishCarOf, railcarRideStep, rideProgress } from "./railcar-sweep.ts";
import { fits, lookupTables, sendIxs } from "./send.ts";

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
          simulate: (ix: TransactionInstruction) => simulatedUnits(ctx.conn, caller, [ix], opts),
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

/**
 * Why an Active Match with no committed result waits (`SweepDeps.waiting`): `untabled` with no Assignment once the Game's
 * table wait after the join is over (the same rule as the Players' pages), `unbegun` once its Assignment's start window closed.
 * Base cannot tell a Match that never began from one still playing on a delegated table, so a long Match past its start
 * window is also asked about every 5 minutes: two reads each time.
 */
export function waitingOf(a: { startDeadline: number } | null, deadline: number, nowS: number): "untabled" | "unbegun" | null {
  if (!a) return untabledRefundDue(deadline, nowS) ? "untabled" : null;
  return nowS > a.startDeadline ? "unbegun" : null;
}

/** Sends the Game's `refund_untabled`; a refusal for a Match that is no longer Active (a page or another run did it) is a lost race. */
export async function untabledOrRaced<S>(chain: { refundUntabled(payer: S, match: PublicKey): Promise<string> }, signer: S, match: PublicKey, stillActive: () => Promise<boolean>): Promise<string> {
  try {
    return await chain.refundUntabled(signer, match);
  } catch (e) {
    if (!(await stillActive().catch(() => true))) throw new Raced("the Match was already refunded by another caller");
    throw e;
  }
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

  // Assignments read by `committed` this run, so `waiting` does not read them again.
  const assignments = new Map<string, { startDeadline: number } | null>();

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
      assignments.set(head.address.toBase58(), a ?? null);
      // A failed read throws: the sweep must not read it as "no result" and refund a Match whose result is committed.
      const base = a ? await game.chain.readTableOnBase(a) : null;
      return !!a && !!base && game.canFinalize(base, a, ctx.now);
    },
    progress: async (address) => {
      const info = await ctx.conn.getAccountInfo(address);
      if (info && carHeadAt(address, info.data)) return carProgressKey(ctx, address, info.data);
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
      if (info && carHeadAt(address, info.data)) return finishCarOf(ctx, address);
      const result = await finishMatch(finisher, address);
      if (result.stalled && result.stalled !== "step-limit") throw new Error(`stalled: ${result.stalled}`);
    },
    ride: async (head) => {
      await observeBalance();
      if (!head.game.equals(RAILCAR_PROGRAM_ID)) throw new Error(`no ride adapter for game ${head.game.toBase58()}`);
      await railcarRideStep(ctx, head.address);
    },
    waiting: async (head) => {
      const game = gameOf(ctx, head.game);
      if (!game || !head.joined) return null;
      const id = head.address.toBase58();
      const a = assignments.has(id) ? assignments.get(id)! : await game.chain.readAssignment(head.address);
      return waitingOf(a ?? null, head.deadline, ctx.now);
    },
    refundUntabled: async (head) => {
      await observeBalance();
      const game = gameOf(ctx, head.game);
      if (!game) throw new Error(`unknown game ${head.game.toBase58()}`);
      const stillActive = async () => (await fetchView(ctx, head.address))?.stage === "active";
      const r = await act(ctx, "sweep", subject(head.address), "refund_untabled (joined, no table within the Game's table wait)", () => untabledOrRaced(game.chain, ctx.hsigner, head.address, stillActive));
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok && r.detail !== "raced") throw new Error(r.detail);
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

/** Where a car is: core's stage, run and seats, and while it rides its Table on both layers (a ride step moves one). */
async function carProgressKey(ctx: Ctx, address: PublicKey, data: Buffer): Promise<string> {
  const car = decodeCar(address, data);
  const key = `car:${car.stage}:${car.run.steps}:${car.seated}`;
  if (car.stage !== "departed" || !car.game.equals(RAILCAR_PROGRAM_ID)) return key;
  return `${key}:${await rideProgress(ctx, address)}`;
}
