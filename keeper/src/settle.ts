import type { PublicKey } from "@solana/web3.js";
import { noteError } from "./errors.ts";
import { decodeMatchRecords, innerInstructionsOf, type MatchChunkRecord } from "../../app/src/server/history/events.ts";
import { CHUNK_STEPS, CHUNK_UNITS, closeIx, fullAccounts, loadMatch, viewOf, planChunk as planChunkShared, planSizedChunk as planSizedChunkShared, type ChunkPlan, type Core, type Loaded, type MatchView } from "../../app/src/lib/chain/settle-plan.ts";
import { act, log, type Ctx } from "./act.ts";
import { runOf, sourcesAhead } from "./chunks.ts";
import { growStoreIx, initCkptPageIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { bookOf, matchAddress, matchLabel, type MatchRef } from "./kit.ts";
import { fits, lookupTables, sendIxs, compile, type SendOpts } from "./send.ts";
import { connReader, missingCutPages, type Reader } from "./supply.ts";

export { viewOf, closeRemaining, closeIx, fullAccounts, CHUNK_CU_TARGET } from "../../app/src/lib/chain/settle-plan.ts";
export type { Stage, MatchView, Loaded, ChunkPlan } from "../../app/src/lib/chain/settle-plan.ts";

/** Chunks one Match gets in one pass, so a long Pot cannot hold up the others. */
const CHUNKS_PER_PASS = Number(process.env.KEEPER_CHUNKS_PER_PASS ?? 12);

const load = loadMatch;

/** Builds the next chunk of a Settling or Refunding Match with as many steps as fit one transaction (down to 1). */
export const planChunk = (core: Core, read: Reader, caller: PublicKey, l: Loaded, steps: number, opts: SendOpts = {}) => planChunkShared(core, read, caller, l, steps, (ix) => fits(caller, [ix], opts));

/** The chunk record a transaction emitted for `ref`, if its events can be read. */
export async function chunkReport(ctx: Pick<Ctx, "conn">, signature: string, ref: MatchRef): Promise<MatchChunkRecord | null> {
  const tx = await ctx.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return null;
  const rec = decodeMatchRecords(innerInstructionsOf(tx as any)).find((r): r is MatchChunkRecord => r.type === "chunk" && r.opener === ref.opener.toBase58() && r.n === ref.n);
  return rec ?? null;
}

/** What `driveMatch` reaches the chain through: tests replace it. */
export interface Deps {
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  /** The Match as it is now; null once it is closed away. */
  refetch(address: PublicKey): Promise<MatchView | null>;
  /** The chunk record a sent chunk emitted. */
  report(signature: string, ref: MatchRef): Promise<MatchChunkRecord | null>;
  tables(): Promise<SendOpts["tables"]>;
  /** Compute units a dry run of `ixs` uses; null when it cannot be measured (the chunk is then sent as planned). */
  simulate?(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<number | null>;
}

export const realDeps = (ctx: Ctx): Deps => ({
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  refetch: async (address) => {
    const fresh = await ctx.core.account.matchState.fetchNullable(address);
    return fresh ? viewOf(address, fresh) : null;
  },
  report: (signature, ref) => chunkReport(ctx, signature, ref),
  tables: () => lookupTables(ctx.conn),
  simulate: async (ixs, opts) => {
    try {
      const { blockhash } = await ctx.conn.getLatestBlockhash();
      const tx = compile(ctx.payer.publicKey, blockhash, ixs, opts);
      tx.sign([ctx.payer]);
      const res = (await ctx.conn.simulateTransaction(tx, { sigVerify: false })).value;
      return res.unitsConsumed ?? null;
    } catch {
      return null;
    }
  },
});

/** Plans the next chunk sized to the transaction and the compute target (see the shared planner). */
export const planSizedChunk = (ctx: Pick<Ctx, "core" | "payer">, deps: Deps, l: Loaded, opts: SendOpts, subject: string): Promise<ChunkPlan | null> =>
  planSizedChunkShared(
    {
      core: ctx.core,
      read: deps.read,
      caller: ctx.payer.publicKey,
      fitsOne: (ix) => fits(ctx.payer.publicKey, [ix], opts),
      simulate: deps.simulate && ((ix) => deps.simulate!([ix], opts)),
      log: (message) => log("settle", subject, message),
    },
    l,
  );

/**
 * Drives one Settling or Refunding Match as far as it goes this pass: chunk after chunk until the run is done (then
 * `close_match`), growing the spill of an Account whose credit found no slot. Every step is permissionless and
 * idempotent, so a restart, a second keeper or a Player's own click can interleave without harm.
 */
export async function driveMatch(ctx: Ctx, view: MatchView, deps: Deps = realDeps(ctx)): Promise<number> {
  const { read, send, refetch, report: readReport } = deps;
  const subject = `match=${matchLabel(view.ref)}`;
  const opts: SendOpts = { units: CHUNK_UNITS, tables: await deps.tables() };
  let actions = 0;
  let current = view;
  for (let i = 0; i < CHUNKS_PER_PASS; i++) {
    if (current.stage === "closed") {
      const l = await load(read, current);
      let sig = "";
      const r = await act(ctx, "settle", subject, "close_match (the run is done)", async () => {
        sig = await send([await closeIx(ctx.core, read, ctx.payer.publicKey, l)], { tables: opts.tables, units: 200_000 });
        return sig;
      });
      return actions + +r.ok;
    }
    if (current.stage !== "settling" && current.stage !== "refunding") return actions;
    const l = await load(read, current);
    if (!l.stores[0]) {
      log("settle", subject, "WARN Pot A is gone; nothing to run");
      return actions;
    }
    const run = runOf(current.inner.run);
    const pages = run ? await missingCutPages(read, sourcesAhead(run, l.stores, CHUNK_STEPS)) : [];
    for (const page of pages) {
      const r = await act(ctx, "settle", subject, `init_ckpt_page class ${page.cls} page ${page.pageNo} of ${shortKey(page.source)} before a fee cut`, async () =>
        send([await initCkptPageIx(ctx.core, { payer: ctx.payer.publicKey, book: bookOf(page.source), page: page.address, cls: page.cls, pageNo: page.pageNo })], { units: 200_000 }),
      );
      if (!r.ok) return actions;
      if (r.detail !== "dry-run") actions++;
    }
    if (pages.length && ctx.settings.dryRun) return actions;
    const plan = await planSizedChunk(ctx, deps, l, opts, subject);
    if (!plan) return actions;
    if (plan.missing.length) log("settle", subject, `WARN no book for ${plan.missing.map(shortKey).join(", ")}: the chunk cannot run those steps`);
    if (!fits(ctx.payer.publicKey, [plan.ix], opts)) {
      log("settle", subject, "SKIP the chunk does not fit one transaction even with 1 step: set KEEPER_LOOKUP_TABLES");
      return actions;
    }
    let report: MatchChunkRecord | null = null;
    const r = await act(ctx, "settle", subject, `match_chunk (${current.stage}, up to ${plan.steps} step(s))`, async () => {
      const sig = await send([plan.ix], opts);
      report = await readReport(sig, current.ref).catch(() => null);
      return sig;
    });
    if (!r.ok || r.detail === "dry-run") return actions;
    actions++;
    const fresh = await refetch(current.address);
    if (!fresh) return actions;
    current = fresh;
    const chunk = report as MatchChunkRecord | null;
    if (chunk?.blocked) {
      const full = await fullAccounts(read, plan.credited);
      if (!full.length) {
        log("settle", subject, "WARN the chunk reports blocked but every credited Account has room: needs a look");
        return actions;
      }
      for (const account of full) {
        const g = await act(ctx, "settle", subject, `grow_store spill of ${shortKey(account)} by 1 (a credit found no slot)`, async () =>
          send([await growStoreIx(ctx.core, { payer: ctx.payer.publicKey, account, which: "spill", extra: 1 })], {}),
        );
        actions += +g.ok;
        if (!g.ok) return actions;
      }
    }
  }
  return actions;
}

/** Drives every Settling, Refunding and Closed Match of `views`; returns the number of actions taken. */
export async function settleMatches(ctx: Ctx, views: MatchView[]): Promise<number> {
  let actions = 0;
  for (const v of views) {
    try {
      actions += await driveMatch(ctx, v);
    } catch (e) {
      noteError("settle", `match=${matchLabel(v.ref)}`, e);
    }
  }
  return actions;
}

export { matchAddress };
