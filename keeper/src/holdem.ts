import { PublicKey } from "@solana/web3.js";
import { PHASE, SLOT, TABLE_PHASE, canFinalizeTable, configPda, sponsorPda, tableOf, tablePda, settledPda, type Assignment, type Table } from "../../app/src/games/holdem/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { shortKey } from "./env.ts";
import { keyOf } from "./kit.ts";
import { needsRecommit } from "./recommit.ts";
import { when } from "./tee.ts";

/**
 * Hold'em on persistent tables (the Game's keeper hook).
 *
 * A Match runs on a table that stays in the rollup. The Players' clients do the moves; the keeper only steps in for what either
 * Player may do and a stalled client leaves undone. The table is public (its two Hole seats are not, and the keeper never reads
 * them), so every decision below is made from the table and the Assignment alone: `holdemStep` is that decision, pure.
 *
 * Between Matches a table needs wiping, committing, resetting and its ring slots freed: that is `holdemTableStep` and
 * `maintainHoldemTables`, per table and independent of any Match (the table scheduler of ticket 19t replaces the call).
 */

export interface HoldemFacts {
  /** The Assignment exists. */
  assigned: boolean;
  /** The table's turn is this Match's (same epoch and Match); false when the table moved on, cannot be read, or runs another Match. */
  ours: boolean;
  tablePhase: number;
  seatsOpen: boolean;
  dirty: boolean;
  startDeadline: number;
  /** The hand's phase and its clock (Unix seconds in the rollup): after `handDeadline` anyone may `claim_timeout`. */
  handPhase: number;
  handDeadline: number;
  vrfReady: boolean;
  /** Base's committed copy of the table can settle the Match (a Done result, or the table is past the epoch). */
  finalizable: boolean;
}

export type HoldemStep = {
  do: "assign" | "finalize" | "begin_match" | "seat_players" | "expire_start" | "deal" | "claim_timeout" | "commit_table" | "refund" | "wait";
  why: string;
};

/**
 * What to do with one unsettled Hold'em Match.
 *  - No Assignment: the table scheduler binds the Match to an Idle table (`assign`), while it is young enough to start.
 *  - Base's committed table can settle it: `finalize`, whatever else is going on.
 *  - Idle at the Match's epoch: `begin_match`. Waiting: `seat_players` once, then both Players check in (their clients); past the
 *    start deadline with one missing: `expire_start`, which writes a refund into the ring.
 *  - Live, at the shuffle: when the oracle's answer is in, `deal` after a short grace; past the hand's clock, `claim_timeout`.
 *    Live, in a hand: past the turn clock, `claim_timeout` (checks or folds the idle Player, forfeits after three misses).
 *  - Over and not committed: `commit_table` (the table is `dirty` until then, so this runs once per result).
 *  - Anything else: wait for tesoro_core's own refund at the Match deadline.
 */
export function holdemStep(d: HoldemFacts, now: number, deadline: number): HoldemStep {
  if (!d.assigned) {
    if (now >= deadline) return { do: "refund", why: "no table was assigned before the Match deadline" };
    return { do: "assign", why: "the Match has no table yet" };
  }
  if (d.finalizable) return { do: "finalize", why: "the committed table holds the result" };
  if (!d.ours) {
    if (now >= deadline) return { do: "refund", why: "the table never settled the Match before the Match deadline" };
    return { do: "wait", why: `table is on another Match or epoch; refundable ${when(deadline, now)}` };
  }
  if (d.tablePhase === TABLE_PHASE.idle) {
    if (now <= d.startDeadline) return { do: "begin_match", why: "assigned table is Idle at the Match's epoch" };
    return { do: "wait", why: `start window passed; refundable ${when(deadline, now)}` };
  }
  if (d.tablePhase === TABLE_PHASE.waiting) {
    if (now > d.startDeadline) return { do: "expire_start", why: "a Player never checked in before the start deadline" };
    if (!d.seatsOpen) return { do: "seat_players", why: "Match begun, seats not handed to the Players" };
    return { do: "wait", why: `waiting for check-ins until ${when(d.startDeadline, now)}` };
  }
  if (d.tablePhase === TABLE_PHASE.live) {
    if (now > d.handDeadline) return { do: "claim_timeout", why: "the hand's clock ran out" };
    if (d.handPhase === PHASE.shuffle && d.vrfReady) return { do: "deal", why: "the oracle answered, nobody dealt" };
    return { do: "wait", why: `hand clock until ${when(d.handDeadline, now)}` };
  }
  if (d.tablePhase === TABLE_PHASE.over && d.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  return { do: "wait", why: `committed, waiting for the base layer to show it; refundable ${when(deadline, now)}` };
}

/** Facts for `holdemStep` from the Assignment, the table in the rollup and base's copy of it. */
export function holdemFacts(a: Assignment | null, live: Table | null, base: Table | null, nowS: number): HoldemFacts {
  const ours = !!a && !!live && !!tableOf(a, live);
  return {
    assigned: !!a,
    ours,
    tablePhase: live?.tablePhase ?? TABLE_PHASE.idle,
    seatsOpen: live?.seatsOpen ?? false,
    dirty: live?.dirty ?? false,
    startDeadline: a?.startDeadline ?? 0,
    handPhase: live?.phase ?? PHASE.none,
    handDeadline: live?.deadline ?? 0,
    vrfReady: live?.vrfReady ?? false,
    finalizable: !!a && !!base && canFinalizeTable(base, a, nowS),
  };
}

// ---- tables ------------------------------------------------------------------------------------

export interface HoldemTableFacts {
  tablePhase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** Rollup seconds since the result (0 while not Over). */
  sinceOver: number;
  /** Ring slots in the Done state, each with whether tesoro_core's receipt for its Match is old enough (60 s) to free it. */
  doneSlots: { index: number; match: string; receiptOld: boolean }[];
  /** The Match on the table was refunded by tesoro_core (its receipt is old enough) before the table finished it. */
  matchFrozen: boolean;
  /** A Done result in the table's ring that base's copy does not show, old enough that its commit is probably lost, and the wait since the last try has passed. */
  recommit: boolean;
}

export type HoldemTableStep = { do: "commit_table" | "wipe_seats" | "reset_table" | "release_slot" | "void_table" | "wait"; why: string; slot?: { index: number; match: string } };

/** A finished table waits this long (rollup seconds) before it is reset, the program's `RESET_DELAY_SECS`. */
export const RESET_DELAY_SECS = 30;

/** One step for one table; frees ring slots first (it never blocks a Match), then moves the table along. */
export function holdemTableStep(f: HoldemTableFacts): HoldemTableStep {
  const free = f.doneSlots.find((s) => s.receiptOld);
  if (free) return { do: "release_slot", why: `tesoro_core froze ${shortKey(new PublicKey(free.match))}`, slot: { index: free.index, match: free.match } };
  if ((f.tablePhase === TABLE_PHASE.waiting || f.tablePhase === TABLE_PHASE.live) && f.matchFrozen) return { do: "void_table", why: "tesoro_core already refunded the Match the table is on" };
  if (f.recommit) return { do: "commit_table", why: "a result is in the ring but not on base: its commit was probably lost, repeating it" };
  if (f.tablePhase !== TABLE_PHASE.over) return { do: "wait", why: `table phase ${f.tablePhase}` };
  if (f.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  if (f.seatsOpen) return { do: "wipe_seats", why: "Match over, seats still hold the Players" };
  if (f.sinceOver < RESET_DELAY_SECS) return { do: "wait", why: `reset in ${RESET_DELAY_SECS - f.sinceOver}s` };
  return { do: "reset_table", why: "committed, seats wiped" };
}

/** Rollup facts for one table; `receiptAge(match)` is the age in seconds of tesoro_core's settlement receipt, or `null` if there is none. */
export function holdemTableFacts(t: Table, nowS: number, receiptAge: (match: PublicKey) => number | null, base: Table | null = null, lastRecommit = 0): HoldemTableFacts {
  const doneSlots = t.ring
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.state === SLOT.done)
    .map(({ s, index }) => ({ index, match: s.tesoroMatch.toBase58(), receiptOld: (receiptAge(s.tesoroMatch) ?? -1) >= 60 }));
  const onMatch = t.tablePhase === TABLE_PHASE.waiting || t.tablePhase === TABLE_PHASE.live;
  return {
    tablePhase: t.tablePhase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    sinceOver: t.tablePhase === TABLE_PHASE.over ? Math.max(0, Math.floor(nowS - t.overAt)) : 0,
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
export async function holdemTablesOf(ctx: Ctx): Promise<{ generation: number; indexes: number[] }> {
  const cfg: any = await (ctx.holdem.program.account as any).tableConfig.fetch(configPda());
  return { generation: cfg.generation, indexes: Array.from({ length: cfg.maxTables }, (_, i) => i) };
}

const lastRecommit = new Map<string, number>();

/** One maintenance step per table. Returns the number of actions taken. Tables that were never created or are not readable yet are skipped. */
export async function maintainHoldemTables(ctx: Ctx): Promise<number> {
  let cfg;
  try {
    cfg = await holdemTablesOf(ctx);
  } catch {
    return 0; // the Game has no TableConfig yet
  }
  let actions = 0;
  for (const index of cfg.indexes) {
    const address = tablePda(cfg.generation, index);
    const subject = `table=holdem/${cfg.generation}/${index}`;
    const ref = { generation: cfg.generation, index };
    if (!(await ctx.conn.getAccountInfo(address).catch(() => null))) continue;
    const t = await ctx.holdem.readTable(ctx.hsigner, ref).catch(() => null);
    if (!t) continue;
    const ages = new Map<string, number | null>();
    for (const key of [t.tesoroMatch, ...t.ring.filter((s) => s.state === SLOT.done).map((s) => s.tesoroMatch)]) {
      if (!ages.has(key.toBase58())) ages.set(key.toBase58(), await receiptAgeOf(ctx, key, ctx.now));
    }
    const base = await ctx.holdem.readTableOnBase(ref).catch(() => null);
    const step = holdemTableStep(holdemTableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit.get(subject) ?? 0));
    if (step.do === "wait") continue;
    if (step.why.includes("probably lost")) lastRecommit.set(subject, ctx.now);
    const send = (fn: () => Promise<string>) => act(ctx, "match", subject, `${step.do} (${step.why})`, fn);
    let r;
    if (step.do === "release_slot") r = await send(() => ctx.holdem.releaseSlot(ctx.hsigner, address, step.slot!.index, new PublicKey(step.slot!.match)));
    else if (step.do === "void_table") r = await send(() => ctx.holdem.voidTable(ctx.hsigner, address, t.tesoroMatch));
    else if (step.do === "commit_table") r = await send(() => ctx.holdem.commitTable(ctx.hsigner, ref));
    else if (step.do === "wipe_seats") r = await send(() => ctx.holdem.wipeSeats(ctx.hsigner, ref));
    else r = await send(() => ctx.holdem.resetTable(ctx.hsigner, address));
    actions += +r.ok;
  }
  return actions;
}

/** The first table of the current generation that is Idle and not already promised to a Match this process assigned (scheduler entry point for 19t). */
const promised = new Map<string, number>();
export async function pickHoldemTable(ctx: Ctx): Promise<{ generation: number; index: number; epoch: number } | null> {
  const { generation, indexes } = await holdemTablesOf(ctx);
  for (const index of indexes) {
    const t = await ctx.holdem.readTable(ctx.hsigner, { generation, index }).catch(() => null);
    if (!t || t.tablePhase !== TABLE_PHASE.idle || !t.seatsCreated) continue;
    const key = `${generation}/${index}`;
    if (promised.get(key) === t.epoch) continue;
    return { generation, index, epoch: t.epoch };
  }
  return null;
}

/** Sponsor upkeep: the operator moves `amount` from Fuel `fuel` when the Sponsor's rollup balance is below `floorLamports`. */
export async function refillHoldemSponsorIfLow(ctx: Ctx, opts: { fuel: number; amount: bigint; floorLamports: number }): Promise<number> {
  const conn = await ctx.holdem.teeConnection(ctx.hsigner);
  const balance = await conn.getBalance(sponsorPda()).catch(() => null);
  if (balance === null || balance >= opts.floorLamports) return 0;
  const r = await act(ctx, "match", "sponsor", `holdem refill_sponsor (balance ${balance} lamports)`, () => ctx.holdem.refillSponsor(ctx.hsigner, opts.fuel, opts.amount));
  return +r.ok;
}

let lastUpkeep = 0;

/** Hold'em hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function holdem(ctx: Ctx, match: PublicKey, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[holdem ${st}]`;
  let actions = 0;

  if (now !== lastUpkeep) {
    lastUpkeep = now;
    actions += await maintainHoldemTables(ctx).catch((e) => (log("match", "-", `${tag} table upkeep failed: ${String(e?.message ?? e).slice(0, 160)}`), 0));
    actions += await refillHoldemSponsorIfLow(ctx, {
      fuel: Number(process.env.KEEPER_HOLDEM_FUEL ?? 0),
      amount: BigInt(process.env.KEEPER_HOLDEM_FUEL_AMOUNT ?? 50_000_000),
      floorLamports: Number(process.env.KEEPER_HOLDEM_SPONSOR_FLOOR ?? 20_000_000),
    }).catch(() => 0);
  }

  if (st === "open") {
    if (now < deadline) log("match", subject, `${tag} wait: no opponent yet, refundable ${when(deadline, now)}`);
    else return actions + +(await refund(ctx, m, subject, "no opponent before deadline")).ok;
    return actions;
  }

  const a = await ctx.holdem.readAssignment(match);
  const live = a ? await ctx.holdem.readTable(ctx.hsigner, a).catch(() => null) : null;
  const base = a ? await ctx.holdem.readTableOnBase(a).catch(() => null) : null;
  const step = holdemStep(holdemFacts(a, live, base, now), now, deadline);

  if (step.do === "assign") {
    const slot = await pickHoldemTable(ctx);
    if (!slot) {
      log("match", subject, `${tag} wait: no Idle table to assign`);
      return actions;
    }
    const seatA: any = await ctx.core.account.tesoroAccount.fetch(keyOf(m.a.player));
    const seatB: any = await ctx.core.account.tesoroAccount.fetch(keyOf(m.b.player));
    const r = await act(ctx, "match", subject, `assign_match to table ${slot.generation}/${slot.index} epoch ${slot.epoch}`, () =>
      ctx.holdem.assignMatch(ctx.hsigner, match, seatA.authority, seatB.authority, slot.generation, slot.index, slot.epoch),
    );
    if (r.ok) promised.set(`${slot.generation}/${slot.index}`, slot.epoch);
    return actions + +r.ok;
  }
  if (step.do === "refund") return actions + +(await refund(ctx, m, subject, step.why)).ok;
  if (!a) return actions;
  const send = (what: string, fn: () => Promise<string>) => act(ctx, "match", subject, `${what} (${step.why})`, fn);
  if (step.do === "finalize") return actions + +(await send("finalize", () => ctx.holdem.finalize(ctx.hsigner, a))).ok;
  if (step.do === "begin_match") return actions + +(await send("begin_match", () => ctx.holdem.beginMatch(ctx.hsigner, a))).ok;
  if (step.do === "seat_players") return actions + +(await send("seat_players", () => ctx.holdem.seatPlayers(ctx.hsigner, a))).ok;
  if (step.do === "expire_start") return actions + +(await send("expire_start", () => ctx.holdem.expireStart(ctx.hsigner, a))).ok;
  if (step.do === "deal") return actions + +(await send("deal", () => ctx.holdem.deal(ctx.hsigner, a))).ok;
  if (step.do === "claim_timeout") return actions + +(await send("claim_timeout", () => ctx.holdem.claimTimeout(ctx.hsigner, a))).ok;
  if (step.do === "commit_table") return actions + +(await send("commit_table", () => ctx.holdem.commitTable(ctx.hsigner, a))).ok;
  log("match", subject, `${tag} wait: ${step.why}`);
  return actions;
}
