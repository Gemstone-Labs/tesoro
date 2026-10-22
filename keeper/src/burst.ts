import { PublicKey } from "@solana/web3.js";
import {
  CHECKIN_SLOTS,
  MAX_SEED_REQUESTS,
  SEED_RETRY_SECS,
  SEED_SLOTS,
  SLOTS_PER_SEC,
  END_OFFSET_SLOTS,
  SLOT,
  TABLE_PHASE,
  canFinalizeTable,
  configPda,
  settledPda,
  sponsorPda,
  tableOf,
  tablePda,
  type Assignment,
  type Table,
} from "../../app/src/games/block-puzzle/live-chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { shortKey } from "./env.ts";
import { keyOf } from "./kit.ts";
import { needsRecommit } from "./recommit.ts";
import { when } from "./tee.ts";

/**
 * Block Burst Live on persistent tables (the Game's keeper hook).
 *
 * A Match runs on a table that stays in the rollup. The Players' apps check in, begin and play; the keeper steps in for what
 * anyone may do and a stalled client leaves undone: seat the Players, ask for the Seed, start the clock, close the Match when
 * its window is over, commit, finalize. It never checks in or plays for a Player and never reads a hidden account: every
 * decision is made from the table, the Assignment and the rollup's slot, so `burstStep` is pure.
 *
 * Between Matches a table needs wiping, committing, resetting and its ring slots freed: `burstTableStep` and
 * `maintainBurstTables` (the table scheduler of ticket 19t replaces the call).
 */

export interface BurstFacts {
  /** The Assignment exists. */
  assigned: boolean;
  /** The table's turn is this Match's (same epoch and Match); false when the table moved on or cannot be read. */
  ours: boolean;
  tablePhase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** Unix seconds by which the Match must begin on its table. */
  startDeadline: number;
  /** The rollup's current slot. */
  slot: number;
  assignedSlot: number;
  seedingSlot: number;
  startSlot: number;
  seedReady: boolean;
  reqPending: boolean;
  reqSlot: number;
  reqCount: number;
  /** Base's committed copy of the table can settle the Match. */
  finalizable: boolean;
}

export type BurstStep = {
  do: "assign" | "finalize" | "begin_match" | "seat_players" | "request_seed" | "start" | "close" | "commit_table" | "refund" | "wait";
  why: string;
};

/**
 * What to do with one unsettled Block Burst Match.
 *  - No Assignment: bind it to an Idle table (`assign`) while it is young enough to start.
 *  - Base's committed table can settle it: `finalize`, whatever else is going on.
 *  - Idle at the Match's epoch: `begin_match`. Assigned: `seat_players` once; past the check-in window `close` (the present
 *    side wins, neither refunds).
 *  - Seeding: `request_seed` (the first, or a retry every 20 s up to 3), then `start` once the Seed is in; past the Seed window
 *    `close` (refund).
 *  - Running: past the window and its grace, `close`.
 *  - Closed and not committed: `commit_table`.
 */
export function burstStep(d: BurstFacts, now: number, deadline: number): BurstStep {
  if (!d.assigned) {
    if (now >= deadline) return { do: "refund", why: "no table was assigned before the Match deadline" };
    return { do: "assign", why: "the Match has no table yet" };
  }
  if (d.finalizable) return { do: "finalize", why: "the committed table holds the result" };
  if (!d.ours) {
    if (now >= deadline) return { do: "refund", why: "the table never settled the Match before the Match deadline" };
    return { do: "wait", why: `table is on another Match or epoch; refundable ${when(deadline, now)}` };
  }
  switch (d.tablePhase) {
    case TABLE_PHASE.idle:
      if (now <= d.startDeadline) return { do: "begin_match", why: "assigned table is Idle at the Match's epoch" };
      return { do: "wait", why: `start window passed; refundable ${when(deadline, now)}` };
    case TABLE_PHASE.assigned:
      if (d.slot > d.assignedSlot + CHECKIN_SLOTS) return { do: "close", why: "the check-in window is over" };
      if (!d.seatsOpen) return { do: "seat_players", why: "Match begun, seats not handed to the Players" };
      return { do: "wait", why: `waiting for check-ins ${Math.ceil((d.assignedSlot + CHECKIN_SLOTS - d.slot) / SLOTS_PER_SEC)}s more` };
    case TABLE_PHASE.seeding: {
      if (d.slot > d.seedingSlot + SEED_SLOTS) return { do: "close", why: "the Seed never arrived in its window" };
      if (d.seedReady) return { do: "start", why: "the Seed is in, nobody started the clock" };
      const retryDue = !d.reqPending || d.slot >= d.reqSlot + SEED_RETRY_SECS * SLOTS_PER_SEC;
      if (d.reqCount < MAX_SEED_REQUESTS && retryDue) return { do: "request_seed", why: d.reqCount === 0 ? "both checked in, no Seed requested" : "the Seed answer is late, asking again" };
      return { do: "wait", why: "waiting for the oracle's Seed" };
    }
    case TABLE_PHASE.getReady:
      if (d.slot > d.startSlot + END_OFFSET_SLOTS) return { do: "close", why: "the run and its grace are over" };
      return { do: "wait", why: `running until slot ${d.startSlot + END_OFFSET_SLOTS}` };
    case TABLE_PHASE.closed:
      if (d.dirty) return { do: "commit_table", why: "the result is not committed yet" };
      return { do: "wait", why: `committed, waiting for the base layer to show it; refundable ${when(deadline, now)}` };
    default:
      return { do: "wait", why: `table phase ${d.tablePhase}` };
  }
}

/** Facts for `burstStep` from the Assignment, the table in the rollup, base's copy of it and the rollup's slot. */
export function burstFacts(a: Assignment | null, live: Table | null, base: Table | null, nowS: number, slot: number): BurstFacts {
  const ours = !!a && !!live && !!tableOf(a, live);
  return {
    assigned: !!a,
    ours,
    tablePhase: live?.phase ?? TABLE_PHASE.idle,
    seatsOpen: live?.seatsOpen ?? false,
    dirty: live?.dirty ?? false,
    startDeadline: a?.startDeadline ?? 0,
    slot,
    assignedSlot: live?.assignedSlot ?? 0,
    seedingSlot: live?.seedingSlot ?? 0,
    startSlot: live?.startSlot ?? 0,
    seedReady: live?.seedReady ?? false,
    reqPending: live?.reqPending ?? false,
    reqSlot: live?.reqSlot ?? 0,
    reqCount: live?.reqCount ?? 0,
    finalizable: !!a && !!base && canFinalizeTable(base, a, nowS),
  };
}

// ---- tables ------------------------------------------------------------------------------------

export interface BurstTableFacts {
  tablePhase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** Rollup seconds since the result (0 while not Closed). */
  sinceOver: number;
  /** Ring slots in the Done state, each with whether tesoro_core's receipt for its Match is old enough (60 s) to free it. */
  doneSlots: { index: number; match: string; receiptOld: boolean }[];
  /** The Match on the table was refunded by tesoro_core (its receipt is old enough) before the table finished it. */
  matchFrozen: boolean;
  /** A Done result in the table's ring that base's copy does not show, old enough that its commit is probably lost. */
  recommit: boolean;
}

export type BurstTableStep = { do: "commit_table" | "wipe_seats" | "reset_table" | "release_slot" | "void_table" | "wait"; why: string; slot?: { index: number; match: string } };

/** A finished table waits this long (rollup seconds) before it is reset, the program's `RESET_DELAY_SECS`. */
export const RESET_DELAY_SECS = 30;

/** One step for one table; frees ring slots first (it never blocks a Match), then moves the table along. */
export function burstTableStep(f: BurstTableFacts): BurstTableStep {
  const free = f.doneSlots.find((s) => s.receiptOld);
  if (free) return { do: "release_slot", why: `tesoro_core froze ${shortKey(new PublicKey(free.match))}`, slot: { index: free.index, match: free.match } };
  const onMatch = f.tablePhase >= TABLE_PHASE.assigned && f.tablePhase <= TABLE_PHASE.getReady;
  if (onMatch && f.matchFrozen) return { do: "void_table", why: "tesoro_core already refunded the Match the table is on" };
  if (f.recommit) return { do: "commit_table", why: "a result is in the ring but not on base: its commit was probably lost, repeating it" };
  if (f.tablePhase !== TABLE_PHASE.closed) return { do: "wait", why: `table phase ${f.tablePhase}` };
  if (f.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  if (f.seatsOpen) return { do: "wipe_seats", why: "Match over, seats still hold the Players" };
  if (f.sinceOver < RESET_DELAY_SECS) return { do: "wait", why: `reset in ${RESET_DELAY_SECS - f.sinceOver}s` };
  return { do: "reset_table", why: "committed, seats wiped" };
}

/** Rollup facts for one table; `receiptAge(match)` is the age in seconds of tesoro_core's settlement receipt, or `null` if there is none. */
export function burstTableFacts(t: Table, nowS: number, receiptAge: (match: PublicKey) => number | null, base: Table | null = null, lastRecommit = 0): BurstTableFacts {
  const doneSlots = t.ring
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.state === SLOT.done)
    .map(({ s, index }) => ({ index, match: s.tesoroMatch.toBase58(), receiptOld: (receiptAge(s.tesoroMatch) ?? -1) >= 60 }));
  const onMatch = t.phase >= TABLE_PHASE.assigned && t.phase <= TABLE_PHASE.getReady;
  return {
    tablePhase: t.phase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    sinceOver: t.phase === TABLE_PHASE.closed ? Math.max(0, Math.floor(nowS - t.overAt)) : 0,
    doneSlots,
    matchFrozen: onMatch && (receiptAge(t.tesoroMatch) ?? -1) >= 60,
    recommit: needsRecommit(t, base, nowS, lastRecommit),
  };
}

async function receiptAgeOf(ctx: Ctx, match: PublicKey, nowS: number): Promise<number | null> {
  const info = await ctx.conn.getAccountInfo(settledPda(match)).catch(() => null);
  if (!info) return null;
  const r: any = ctx.core.coder.accounts.decode("settlementReceipt", info.data);
  return nowS - Number(r.receipt.at.toString());
}

/** Tables of the current generation, as many as `TableConfig` allows. */
export async function burstTablesOf(ctx: Ctx): Promise<{ generation: number; indexes: number[] }> {
  const cfg: any = await (ctx.burst.program.account as any).tableConfig.fetch(configPda());
  return { generation: cfg.generation, indexes: Array.from({ length: cfg.maxTables }, (_, i) => i) };
}

const lastRecommit = new Map<string, number>();

/** One maintenance step per table. Returns the number of actions taken. Tables that were never created or are not readable yet are skipped. */
export async function maintainBurstTables(ctx: Ctx): Promise<number> {
  let cfg;
  try {
    cfg = await burstTablesOf(ctx);
  } catch {
    return 0; // the Game has no TableConfig yet
  }
  let actions = 0;
  for (const index of cfg.indexes) {
    const address = tablePda(cfg.generation, index);
    const subject = `table=block-burst/${cfg.generation}/${index}`;
    const ref = { generation: cfg.generation, index };
    if (!(await ctx.conn.getAccountInfo(address).catch(() => null))) continue;
    const t = await ctx.burst.readTable(ctx.hsigner, ref).catch(() => null);
    if (!t) continue;
    const ages = new Map<string, number | null>();
    for (const key of [t.tesoroMatch, ...t.ring.filter((s) => s.state === SLOT.done).map((s) => s.tesoroMatch)]) {
      if (!ages.has(key.toBase58())) ages.set(key.toBase58(), await receiptAgeOf(ctx, key, ctx.now));
    }
    const base = await ctx.burst.readTableOnBase(ref).catch(() => null);
    const step = burstTableStep(burstTableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit.get(subject) ?? 0));
    if (step.do === "wait") continue;
    if (step.why.includes("probably lost")) lastRecommit.set(subject, ctx.now);
    const send = (fn: () => Promise<string>) => act(ctx, "match", subject, `${step.do} (${step.why})`, fn);
    let r;
    if (step.do === "release_slot") r = await send(() => ctx.burst.releaseSlot(ctx.hsigner, address, step.slot!.index, new PublicKey(step.slot!.match)));
    else if (step.do === "void_table") r = await send(() => ctx.burst.voidTable(ctx.hsigner, address, t.tesoroMatch));
    else if (step.do === "commit_table") r = await send(() => ctx.burst.commitTable(ctx.hsigner, ref));
    else if (step.do === "wipe_seats") r = await send(() => ctx.burst.wipeSeats(ctx.hsigner, ref));
    else r = await send(() => ctx.burst.resetTable(ctx.hsigner, address));
    actions += +r.ok;
  }
  return actions;
}

/** The first table of the current generation that is Idle and not already promised to a Match this process assigned (scheduler entry point for 19t). */
const promised = new Map<string, number>();
export async function pickBurstTable(ctx: Ctx): Promise<{ generation: number; index: number; epoch: number } | null> {
  const { generation, indexes } = await burstTablesOf(ctx);
  for (const index of indexes) {
    const t = await ctx.burst.readTable(ctx.hsigner, { generation, index }).catch(() => null);
    if (!t || t.phase !== TABLE_PHASE.idle || !t.seatsCreated) continue;
    const key = `${generation}/${index}`;
    if (promised.get(key) === t.epoch) continue;
    return { generation, index, epoch: t.epoch };
  }
  return null;
}

/** Sponsor upkeep: the operator moves `amount` from Fuel `fuel` when the Sponsor's rollup balance is below `floorLamports`. */
export async function refillBurstSponsorIfLow(ctx: Ctx, opts: { fuel: number; amount: bigint; floorLamports: number }): Promise<number> {
  const conn = await ctx.burst.teeConnection(ctx.hsigner);
  const balance = await conn.getBalance(sponsorPda()).catch(() => null);
  if (balance === null || balance >= opts.floorLamports) return 0;
  const r = await act(ctx, "match", "sponsor", `block-burst refill_sponsor (balance ${balance} lamports)`, () => ctx.burst.refillSponsor(ctx.hsigner, opts.fuel, opts.amount));
  return +r.ok;
}

let lastUpkeep = 0;

/** Block Burst hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function blockBurst(ctx: Ctx, match: PublicKey, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[block-burst ${st}]`;
  let actions = 0;

  if (now !== lastUpkeep) {
    lastUpkeep = now;
    actions += await maintainBurstTables(ctx).catch((e) => (log("match", "-", `${tag} table upkeep failed: ${String(e?.message ?? e).slice(0, 160)}`), 0));
    actions += await refillBurstSponsorIfLow(ctx, {
      fuel: Number(process.env.KEEPER_BURST_FUEL ?? 0),
      amount: BigInt(process.env.KEEPER_BURST_FUEL_AMOUNT ?? 50_000_000),
      floorLamports: Number(process.env.KEEPER_BURST_SPONSOR_FLOOR ?? 20_000_000),
    }).catch(() => 0);
  }

  if (st === "open") {
    if (now < deadline) log("match", subject, `${tag} wait: no opponent yet, refundable ${when(deadline, now)}`);
    else return actions + +(await refund(ctx, m, subject, "no opponent before deadline")).ok;
    return actions;
  }

  const a = await ctx.burst.readAssignment(match);
  const live = a ? await ctx.burst.readTable(ctx.hsigner, a).catch(() => null) : null;
  const base = a ? await ctx.burst.readTableOnBase(a).catch(() => null) : null;
  const slot = live ? await ctx.burst.currentSlot(ctx.hsigner).catch(() => 0) : 0;
  const step = burstStep(burstFacts(a, live, base, now, slot), now, deadline);

  if (step.do === "assign") {
    const pick = await pickBurstTable(ctx);
    if (!pick) {
      log("match", subject, `${tag} wait: no Idle table to assign`);
      return actions;
    }
    const seatA: any = await ctx.core.account.tesoroAccount.fetch(keyOf(m.a.player));
    const seatB: any = await ctx.core.account.tesoroAccount.fetch(keyOf(m.b.player));
    const r = await act(ctx, "match", subject, `assign_match to table ${pick.generation}/${pick.index} epoch ${pick.epoch}`, () =>
      ctx.burst.assignMatch(ctx.hsigner, match, seatA.authority, seatB.authority, pick.generation, pick.index, pick.epoch),
    );
    if (r.ok) promised.set(`${pick.generation}/${pick.index}`, pick.epoch);
    return actions + +r.ok;
  }
  if (step.do === "refund") return actions + +(await refund(ctx, m, subject, step.why)).ok;
  if (!a) return actions;
  const send = (what: string, fn: () => Promise<string>) => act(ctx, "match", subject, `${what} (${step.why})`, fn);
  if (step.do === "finalize") return actions + +(await send("finalize", () => ctx.burst.finalize(ctx.hsigner, a))).ok;
  if (step.do === "begin_match") return actions + +(await send("begin_match", () => ctx.burst.beginMatch(ctx.hsigner, a))).ok;
  if (step.do === "seat_players") return actions + +(await send("seat_players", () => ctx.burst.seatPlayers(ctx.hsigner, a))).ok;
  if (step.do === "request_seed") return actions + +(await send("request_seed", () => ctx.burst.requestSeed(ctx.hsigner, a))).ok;
  if (step.do === "start") return actions + +(await send("start", () => ctx.burst.start(ctx.hsigner, a))).ok;
  if (step.do === "close") return actions + +(await send("close", () => ctx.burst.close(ctx.hsigner, a))).ok;
  if (step.do === "commit_table") return actions + +(await send("commit_table", () => ctx.burst.commitTable(ctx.hsigner, a))).ok;
  log("match", subject, `${tag} wait: ${step.why}`);
  return actions;
}
