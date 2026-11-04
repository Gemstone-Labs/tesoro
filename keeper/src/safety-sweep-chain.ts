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
import { Deferred, SLICE_LEN, headOf, type Head, type SweepDeps } from "./safety-sweep.ts";
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
      const head = row ? headOf(address, Buffer.from(row.data[0], "base64")) : null;
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

  return {
    ...(db && {
      dbMatches: () => dbMatches(db),
      readHeads: (addresses: PublicKey[]) => readHeadsByAddress(rpc, addresses),
      markGone: (addresses: PublicKey[]) => markGone(db, addresses),
    }),
    scan: async () => {
      const filters = [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf("MatchState")) } }];
      const rows = await scanProgramAccounts(rpc, CORE_ID, { filters, dataSlice: { offset: 0, length: SLICE_LEN } });
      return rows.map((r) => headOf(r.pubkey, r.account.data)).filter((h): h is Head => !!h);
    },
    committed: async (head) => {
      const game = gameOf(ctx, head.game);
      if (!game) return false;
      const a = await game.chain.readAssignment(head.address);
      const base = a ? await game.chain.readTableOnBase(a).catch(() => null) : null;
      return !!a && !!base && game.canFinalize(base, a, ctx.now);
    },
    progress: async (address) => {
      const view = await fetchView(ctx, address);
      if (!view) return null;
      const p = progressOf(view);
      return `${p.stage}:${p.phase}:${p.line}`;
    },
    finalize: async (head) => {
      const game = gameOf(ctx, head.game);
      if (!game) throw new Error(`unknown game ${head.game.toBase58()}`);
      const a = await game.chain.readAssignment(head.address);
      if (!a) throw new Error("no Assignment");
      const r = await act(ctx, "sweep", subject(head.address), "finalize (the committed table holds the result)", () => finalizeOrRaced(game.chain, ctx.hsigner, a));
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok && r.detail !== "raced") throw new Error(r.detail);
    },
    finish: async (address) => {
      const result = await finishMatch(finisher, address);
      if (result.stalled && result.stalled !== "step-limit") throw new Error(`stalled: ${result.stalled}`);
    },
    refund: async (head) => {
      const r = await act(ctx, "sweep", subject(head.address), "refund_match (a Backer funded it and nobody joined before the deadline)", async () =>
        sendIxs(ctx.conn, ctx.payer, [await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: head.game, matchState: head.address })], { units: 300_000 }),
      );
      if (r.detail === "budget") throw new Deferred("hourly spend cap reached");
      if (!r.ok && r.detail !== "raced") throw new Error(r.detail);
    },
  };
}

