import { PublicKey } from "@solana/web3.js";
import { settledPda } from "../../app/src/games/holdem/chain.ts";
import { PHASE, SLOT, configPda, sponsorPda, tablePda, type Table } from "../../app/src/games/trading-duel/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { resetMayProceed, duelEndState } from "./end-state.ts";
import { shortKey } from "./env.ts";
import { needsRecommit } from "./recommit.ts";

/**
 * Trading Duel table upkeep (entry points for the table scheduler, ticket 19t).
 *
 * A table plays Match after Match. The per-Match hook (`duel.ts`) drives a Match from Assignment to settlement; what a table
 * needs between Matches is done here, per table and independent of any Match: close the seats, reset, free ring slots once
 * tesoro_core froze their Match, give up a table whose Match tesoro_core already refunded. The pure decision is
 * `tableStep`; `maintainTables` reads every table of the current generation and does one step per table per pass.
 */

export interface TableFacts {
  phase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** Rollup seconds since the result (0 while not Over). */
  sinceOver: number;
  /** Ring slots in the Done state, each with whether tesoro_core's receipt for its Match is old enough (60 s) to free it. */
  doneSlots: { index: number; match: string; receiptOld: boolean }[];
  /** The Match on the table was refunded by tesoro_core (its receipt is old enough) before the table finished it. */
  matchFrozen: boolean;
  /** A Done result in the ring that base's copy does not show, old enough that its commit is probably lost, and the wait since the last try has passed. */
  recommit: boolean;
}

export type TableStep = { do: "commit_table" | "close_seats" | "reset_table" | "release_slot" | "void_table" | "wait"; why: string; slot?: { index: number; match: string } };

/** A finished table waits this long (rollup seconds) before it is reset, the program's `RESET_DELAY_SECS`. */
export const RESET_DELAY_SECS = 30;

/** One step for one table; frees ring slots first (it never blocks a Match), then moves the table along. */
export function tableStep(f: TableFacts): TableStep {
  const free = f.doneSlots.find((s) => s.receiptOld);
  if (free) return { do: "release_slot", why: `tesoro_core froze ${shortKey(new PublicKey(free.match))}`, slot: { index: free.index, match: free.match } };
  if ((f.phase === PHASE.waiting || f.phase === PHASE.live) && f.matchFrozen) return { do: "void_table", why: "tesoro_core already refunded the Match the table is on" };
  if (f.recommit) return { do: "commit_table", why: "a result is in the ring but not on base: its commit was probably lost, repeating it" };
  if (f.phase !== PHASE.over) return { do: "wait", why: `table phase ${f.phase}` };
  if (f.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  if (f.seatsOpen) return { do: "close_seats", why: "Match over, Books still open" };
  if (f.sinceOver < RESET_DELAY_SECS) return { do: "wait", why: `reset in ${RESET_DELAY_SECS - f.sinceOver}s` };
  return { do: "reset_table", why: "committed, seats closed" };
}

/** Rollup facts for one table; `receiptAge(match)` is the age in seconds of tesoro_core's settlement receipt, or `null` if there is none. */
export function tableFacts(t: Table, nowS: number, receiptAge: (match: PublicKey) => number | null, base: Table | null = null, lastRecommit = 0): TableFacts {
  const doneSlots = t.ring
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.state === SLOT.done)
    .map(({ s, index }) => ({ index, match: s.tesoroMatch.toBase58(), receiptOld: (receiptAge(s.tesoroMatch) ?? -1) >= 60 }));
  const onMatch = t.phase === PHASE.waiting || t.phase === PHASE.live;
  return {
    phase: t.phase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    sinceOver: t.phase === PHASE.over ? Math.max(0, Math.floor(nowS - t.overAt)) : 0,
    doneSlots,
    matchFrozen: onMatch && (receiptAge(t.tesoroMatch) ?? -1) >= 60,
    recommit: needsRecommit(t, base, nowS, lastRecommit),
  };
}

/** Age in seconds of the settlement receipt of a Match (from its `at`), `null` if none exists. Reads base. */
async function receiptAgeOf(ctx: Ctx, match: PublicKey, nowS: number): Promise<number | null> {
  const info = await ctx.conn.getAccountInfo(settledPda(match)).catch(() => null);
  if (!info) return null;
  const r: any = ctx.core.coder.accounts.decode("settlementReceipt", info.data);
  return nowS - Number(r.receipt.at.toString());
}

/** Tables of the current generation, as many as `TableConfig` allows. */
export async function tablesOf(ctx: Ctx): Promise<{ generation: number; indexes: number[] }> {
  const cfg: any = await (ctx.duel.program.account as any).tableConfig.fetch(configPda());
  return { generation: cfg.generation, indexes: Array.from({ length: cfg.maxTables }, (_, i) => i) };
}

const lastRecommit = new Map<string, number>();

/**
 * One maintenance step per table. Returns the number of actions taken. Tables that were never created or are not readable
 * in the rollup yet are skipped.
 */
export async function maintainTables(ctx: Ctx): Promise<number> {
  let cfg;
  try {
    cfg = await tablesOf(ctx);
  } catch {
    return 0; // the Game has no TableConfig yet (not deployed with tables)
  }
  let actions = 0;
  for (const index of cfg.indexes) {
    const address = tablePda(cfg.generation, index);
    const subject = `table=${cfg.generation}/${index}`;
    const info = await ctx.conn.getAccountInfo(address).catch(() => null);
    if (!info) continue;
    const ref = { generation: cfg.generation, index };
    const t = await ctx.duel.readTable(ctx.hsigner, ref).catch(() => null);
    if (!t) continue;
    const ages = new Map<string, number | null>();
    for (const key of [t.tesoroMatch, ...t.ring.filter((s) => s.state === SLOT.done).map((s) => s.tesoroMatch)]) {
      if (!ages.has(key.toBase58())) ages.set(key.toBase58(), await receiptAgeOf(ctx, key, ctx.now));
    }
    const base = await ctx.duel.readTableOnBase(ref).catch(() => null);
    const step = tableStep(tableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit.get(subject) ?? 0));
    if (step.do === "wait") continue;
    if (step.why.includes("probably lost")) lastRecommit.set(subject, ctx.now);
    if (step.do === "reset_table" && !(await resetMayProceed({ tesoroMatch: t.tesoroMatch, epoch: t.epoch, fn: duelEndState, table: t }, Math.max(0, Math.floor(ctx.now - t.overAt)), undefined, subject))) continue;
    const sig = (fn: () => Promise<string>) => act(ctx, "match", subject, `${step.do} (${step.why})`, fn);
    let r;
    if (step.do === "release_slot") r = await sig(() => ctx.duel.releaseSlot(ctx.hsigner, address, step.slot!.index, new PublicKey(step.slot!.match)));
    else if (step.do === "void_table") r = await sig(() => ctx.duel.voidTable(ctx.hsigner, address, t.tesoroMatch));
    else if (step.do === "commit_table") r = await sig(() => ctx.duel.commitTable(ctx.hsigner, ref));
    else if (step.do === "close_seats") r = await sig(() => ctx.duel.closeSeats(ctx.hsigner, ref));
    else r = await sig(() => ctx.duel.resetTable(ctx.hsigner, address));
    actions += +r.ok;
  }
  return actions;
}

/**
 * Sponsor upkeep: when the Sponsor's rollup balance is below `floorLamports`, the operator moves `amount` from Fuel `fuel`.
 * Returns whether a refill was sent. (Which Fuel, how much and how often is the operator's runbook.)
 */
export function sponsorNeedsFuel(balance: number, floorLamports: number): boolean {
  return balance < floorLamports;
}

export async function refillSponsorIfLow(ctx: Ctx, opts: { fuel: number; amount: bigint; floorLamports: number }): Promise<number> {
  const conn = await ctx.duel.teeConnection(ctx.hsigner);
  const balance = await conn.getBalance(sponsorPda()).catch(() => null);
  if (balance === null || !sponsorNeedsFuel(balance, opts.floorLamports)) return 0;
  const r = await act(ctx, "match", "sponsor", `refill_sponsor (balance ${balance} lamports)`, () => ctx.duel.refillSponsor(ctx.hsigner, opts.fuel, opts.amount));
  return +r.ok;
}
