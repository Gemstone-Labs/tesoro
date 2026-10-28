import { PublicKey } from "@solana/web3.js";
import { atAssignedEpoch } from "../../app/src/lib/chain/table-epoch.ts";
import { PHASE, SLOT, TABLE_PHASE, canFinalizeTable, tableOf, type Assignment, type Table } from "../../app/src/games/holdem/chain.ts";
import { act, finalizeOrRaced, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { shortKey } from "./env.ts";
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
 * the table scheduler (`scheduler.ts`, ticket 19t), per table and independent of any Match.
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
 *    start deadline with one missing: `expire_start`, which ends it in the ring (the Player who checked in wins; nobody did: a no-show).
 *  - Live, at the shuffle: when the oracle's answer is in, `deal` after a short grace; past the hand's clock, `claim_timeout`.
 *    Live, in a hand: past the turn clock, `claim_timeout` (checks or folds the idle Player, forfeits after three misses).
 *  - Over and not committed: the table scheduler commits it (`commit_table`; the table is `dirty` until then, so once per result).
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
  const ours = !!a && !!live && (!!tableOf(a, live) || (live.tablePhase === TABLE_PHASE.idle && atAssignedEpoch(a, live)));
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
  if (f.tablePhase === TABLE_PHASE.idle && f.dirty) return { do: "commit_table", why: "a Match that never began was given up (skip_epoch): its refund result is not committed yet" };
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


/** Hold'em hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function holdem(ctx: Ctx, match: PublicKey, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[holdem ${st}]`;
  let actions = 0;

  if (st === "open") {
    if (now < deadline) log("match", subject, `${tag} wait: no opponent yet, refundable ${when(deadline, now)}`);
    else return actions + +(await refund(ctx, m, subject, "no opponent before deadline")).ok;
    return actions;
  }

  const a = await ctx.holdem.readAssignment(match);
  const live = a ? await ctx.holdem.readTable(ctx.hsigner, a).catch(() => null) : null;
  const base = a ? await ctx.holdem.readTableOnBase(a).catch(() => null) : null;
  const step = holdemStep(holdemFacts(a, live, base, now), now, deadline);

  // Table upkeep, assignment and commits belong to the table scheduler (scheduler.ts); this hook drives the Match on its table.
  if (step.do === "assign") {
    log("match", subject, `${tag} wait: the table scheduler assigns a table`);
    return actions;
  }
  if (step.do === "refund") return actions + +(await refund(ctx, m, subject, step.why)).ok;
  if (!a) return actions;
  const send = (what: string, fn: () => Promise<string>) => act(ctx, "match", subject, `${what} (${step.why})`, fn);
  if (step.do === "finalize") return actions + +(await send("finalize", () => finalizeOrRaced(ctx.holdem, ctx.hsigner, a))).ok;
  if (step.do === "begin_match") return actions + +(await send("begin_match", () => ctx.holdem.beginMatch(ctx.hsigner, a))).ok;
  if (step.do === "seat_players") return actions + +(await send("seat_players", () => ctx.holdem.seatPlayers(ctx.hsigner, a))).ok;
  if (step.do === "expire_start") return actions + +(await send("expire_start", () => ctx.holdem.expireStart(ctx.hsigner, a))).ok;
  if (step.do === "deal") return actions + +(await send("deal", () => ctx.holdem.deal(ctx.hsigner, a))).ok;
  if (step.do === "claim_timeout") return actions + +(await send("claim_timeout", () => ctx.holdem.claimTimeout(ctx.hsigner, a))).ok;
  log("match", subject, `${tag} wait: ${step.why}`);
  return actions;
}
