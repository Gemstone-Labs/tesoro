import type { AccountMeta, PublicKey } from "@solana/web3.js";
import { decodeMatchRecords, innerInstructionsOf, type MatchChunkRecord } from "../../app/src/server/history/events.ts";
import { act, log, type Ctx } from "./act.ts";
import { creditedAccounts, runOf, sourcesAhead } from "./chunks.ts";
import { closeMatchIx, growStoreIx, initCkptPageIx, matchChunkIx, meta, type Core } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { OVERFLOW_MATCH, POT_AT, basketOf, bookOf, countersOf, decodeStore, decodeTicketHead, keyOf, matchAddress, matchLabel, matchOverflowId, matchRefOf, overflowAddress, slack, sponsorAddress, spillOf, type MatchRef, type Store } from "./kit.ts";
import { fits, lookupTables, sendIxs, type SendOpts } from "./send.ts";
import { connReader, dedupe, missingCutPages, supplySources, type Reader } from "./supply.ts";

export type Stage = "open" | "active" | "settling" | "refunding" | "closed";

/** A decoded `MatchState` with the fields the keeper reads named. */
export interface MatchView {
  address: PublicKey;
  ref: MatchRef;
  inner: any;
  stage: Stage;
  pots: [PublicKey, PublicKey];
  payer: PublicKey;
  /** The Accounts whose spill still holds slots for this Match (`left` > 0); empty before the room hold existed. */
  room: { account: PublicKey; left: number }[];
}

export function viewOf(address: PublicKey, account: any): MatchView {
  const inner = account.inner;
  return {
    address,
    ref: matchRefOf(inner.id),
    inner,
    stage: Object.keys(inner.stage)[0].toLowerCase() as Stage,
    pots: [keyOf(account.pots[0]), keyOf(account.pots[1])],
    payer: keyOf(account.payer),
    room: ((account.room ?? []) as { account: ArrayLike<number>; left: number }[]).filter((r) => r.left > 0).map((r) => ({ account: keyOf(r.account), left: r.left })),
  };
}

/** Steps one chunk runs: more steps mean fewer transactions but more accounts in each. */
const CHUNK_STEPS = Number(process.env.KEEPER_CHUNK_STEPS ?? 6);
/** Chunks one Match gets in one pass, so a long Pot cannot hold up the others. */
const CHUNKS_PER_PASS = Number(process.env.KEEPER_CHUNKS_PER_PASS ?? 12);
/** Compute units asked for a chunk (a 12-step worst case measured 100-133k). */
const CHUNK_UNITS = 400_000;

interface Loaded {
  view: MatchView;
  pots: (Buffer | null)[];
  stores: (Store | null)[];
}

async function load(read: Reader, view: MatchView): Promise<Loaded> {
  const joined = !!view.inner.b;
  const infos = await read.many(joined ? view.pots : [view.pots[0]]);
  const pots = [infos[0]?.data ?? null, joined ? (infos[1]?.data ?? null) : null];
  const stores = pots.map((p) => (p ? decodeStore(p, POT_AT) : null));
  return { view, pots, stores };
}

export interface ChunkPlan {
  ix: Awaited<ReturnType<typeof matchChunkIx>>;
  steps: number;
  /** Sources the steps touch whose book is missing: the chunk would refuse them. */
  missing: PublicKey[];
  credited: PublicKey[];
}

/** Builds the next chunk of a Settling or Refunding Match with as many steps as fit one transaction (down to 1). */
export async function planChunk(core: Core, read: Reader, caller: PublicKey, l: Loaded, steps: number, opts: SendOpts = {}): Promise<ChunkPlan | null> {
  const run = runOf(l.view.inner.run);
  if (!run) return null;
  const credited = creditedAccounts(l.view.inner, keyOf);
  const stores = await read.many(credited.flatMap((a) => [basketOf(a), spillOf(a)]));
  const storeMetas: AccountMeta[] = credited.flatMap((a, i) => (stores[2 * i] && stores[2 * i + 1] ? [meta(basketOf(a)), meta(spillOf(a))] : []));
  // An Account the Match made an overflow record for (its stores had no room at join): a credit that finds no slot lands there.
  const recordKeys = credited.map((a) => overflowAddress(a, OVERFLOW_MATCH, matchOverflowId(l.view.ref)));
  const records = await read.many(recordKeys);
  records.forEach((r, i) => {
    if (r) storeMetas.push(meta(recordKeys[i]));
  });
  for (let n = Math.max(1, steps); ; n = Math.max(1, Math.floor(n / 2))) {
    const ahead = sourcesAhead(run, l.stores, n);
    const supply = await supplySources(core, read, ahead);
    const remaining = dedupe([...storeMetas, ...supply.metas]);
    const ix = await matchChunkIx(core, { caller, matchState: l.view.address, potA: l.view.pots[0], potB: l.view.inner.b ? l.view.pots[1] : null, steps: n, remaining });
    if (n === 1 || fits(caller, [ix], opts)) return { ix, steps: n, missing: supply.missing, credited };
  }
}

/** Accounts of `credited` whose basket and spill have no room left: the ones a blocked chunk is waiting on. */
export async function fullAccounts(read: Reader, credited: PublicKey[]): Promise<PublicKey[]> {
  const infos = await read.many(credited.flatMap((a) => [basketOf(a), spillOf(a)]));
  return credited.filter((_, i) => {
    const [b, s] = [infos[2 * i], infos[2 * i + 1]];
    return !!b && !!s && slack(decodeStore(b.data), decodeStore(s.data)) <= 0;
  });
}

/** The remaining accounts of `close_match`: the spill of every Account that still holds room, and both Players' counters. */
export function closeRemaining(view: MatchView): AccountMeta[] {
  const out: AccountMeta[] = [];
  const add = (k: PublicKey) => {
    if (!out.some((m) => m.pubkey.equals(k))) out.push(meta(k));
  };
  for (const r of view.room) add(spillOf(r.account));
  add(countersOf(keyOf(view.inner.a.player)));
  if (view.inner.b) add(countersOf(keyOf(view.inner.b.player)));
  return out;
}

export async function closeIx(core: Core, read: Reader, caller: PublicKey, l: Loaded) {
  const { view } = l;
  const joined = !!view.inner.b;
  const head = (i: number) => (l.pots[i] ? decodeTicketHead(l.pots[i]!).payer : null);
  const sponsorInfo = (await read.many([sponsorAddress]))[0];
  return closeMatchIx(core, {
    caller,
    matchState: view.address,
    matchPayer: view.payer,
    potA: view.pots[0],
    potAPayer: head(0)!,
    potB: joined ? view.pots[1] : null,
    potBPayer: joined ? head(1) : null,
    sponsor: sponsorInfo ? sponsorAddress : null,
    remaining: closeRemaining(view),
  });
}

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
});

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
    const plan = await planChunk(ctx.core, read, ctx.payer.publicKey, l, CHUNK_STEPS, opts);
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
      log("settle", `match=${matchLabel(v.ref)}`, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  return actions;
}

export { matchAddress };
