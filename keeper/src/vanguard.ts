import { PublicKey } from "@solana/web3.js";
import { ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import {
  CU,
  SLOT,
  TABLE_PHASE,
  canFinalizeTable,
  tableOf,
  type Assignment,
  type TableState,
} from "../../app/src/games/vanguard/chain.ts";
import { PENDING, STATUS, type Battle } from "../../app/src/games/vanguard/decode.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { holdemTableStep, type HoldemTableFacts } from "./holdem.ts";
import { needsRecommit } from "./recommit.ts";
import { simulate, when } from "./tee.ts";

/**
 * Vanguard on persistent tables (the Game's keeper hook).
 *
 * A Match runs on a table that stays in the rollup. The Players' clients do the moves; the keeper only steps in for what either
 * Player may do and a stalled client leaves undone. The table and its Battle are public (the two Army seats are not, and the
 * keeper never reads them), so every decision below is made from the table, the Battle and the Assignment alone: `vanguardStep`
 * is that decision, pure.
 *
 * Between Matches a table needs committing, wiping, resetting and its ring slots freed: that is `holdemTableStep` (the table
 * protocol is the same for every table Game) and the table scheduler (`scheduler.ts`, ticket 19t), per table and independent of any Match.
 */

/** Seconds past an expired turn or the time cap before the keeper claims it, so the Players' clients get the first try. */
export const GRACE_SECS = Number(process.env.KEEPER_VANGUARD_GRACE_SECS ?? 2);

/** The keeper leaves the first seconds of setup to the Players' clients, which bundle the randomness request with their secret. */
export const SETUP_ASSIST_SECS = 8;
/** `ENTROPY_SECS` in programs/vanguard: setup opens this long before the entropy deadline. */
const ENTROPY_SECS = 60;

export interface VanguardFacts {
  /** The Assignment exists. */
  assigned: boolean;
  /** The table's turn is this Match's (same epoch and Match); false when the table moved on, cannot be read, or runs another Match. */
  ours: boolean;
  tablePhase: number;
  seatsOpen: boolean;
  dirty: boolean;
  /** The Assignment's start deadline (Unix seconds): both Players must have checked in by then. */
  startDeadline: number;
  /** The Battle's status (`STATUS`) and clocks; ignored while the table is not Live or Over. */
  status: number;
  entropyDeadline: number;
  setupDeadline: number;
  deadline: number;
  capDeadline: number;
  pendingKind: number;
  pendingSlot: bigint;
  /** Base's committed copy of the table can settle the Match (a Done result, or the table is past the epoch). */
  finalizable: boolean;
}

export type VanguardStep = {
  do: "assign" | "finalize" | "begin_match" | "seat_players" | "resolve" | "claim_timeout" | "assist_setup" | "commit_table" | "refund" | "wait";
  why: string;
};

/**
 * What to do with one unsettled Vanguard Match. `slot` is the rollup's current slot.
 *  - No Assignment: the table scheduler binds the Match to an Idle table (`assign`), while it is young enough to start.
 *  - Base's committed table can settle it: `finalize`, whatever else is going on.
 *  - Idle at the Match's epoch: `begin_match`. Waiting: `seat_players` once, then both Players check in (their clients); past the
 *    start deadline with one missing: `claim_timeout`, which ends it in the ring (the Player who checked in wins; nobody did: a no-show).
 *  - Past the tesoro_core deadline an unfinished Match is refunded on the base layer whatever the rollup serves.
 *  - Live: a declared action comes first: any caller may `resolve` it from a later slot than its declare, and while one is pending
 *    nothing else is accepted. Then the setup, turn and cap clocks: each is a `claim_timeout` (a cancel, or a declare of a lost turn
 *    that the next pass resolves) once GRACE_SECS past. The rollup clock may be behind the base clock, so the caller simulates
 *    `claim_timeout` and waits if refused.
 *  - Over and not committed: `commit_table` (the table is `dirty` until then, so this runs once per result).
 *  - Anything else: wait for tesoro_core's own refund at the Match deadline.
 */
export function vanguardStep(f: VanguardFacts, now: number, deadline: number, slot: bigint): VanguardStep {
  if (!f.assigned) {
    if (now >= deadline) return { do: "refund", why: "no table was assigned before the Match deadline" };
    return { do: "assign", why: "the Match has no table yet" };
  }
  if (f.finalizable) return { do: "finalize", why: "the committed table holds the result" };
  if (!f.ours) {
    if (now >= deadline) return { do: "refund", why: "the table never settled the Match before the Match deadline" };
    return { do: "wait", why: `table is on another Match or epoch; refundable ${when(deadline, now)}` };
  }
  if (f.tablePhase === TABLE_PHASE.over) {
    if (f.dirty) return { do: "commit_table", why: "the result is not committed yet" };
    return { do: "wait", why: `committed, waiting for the base layer to show it; refundable ${when(deadline, now)}` };
  }
  if (now >= deadline) return { do: "refund", why: "Match never finished before the Match deadline" };
  if (f.tablePhase === TABLE_PHASE.idle) {
    if (now <= f.startDeadline) return { do: "begin_match", why: "assigned table is Idle at the Match's epoch" };
    return { do: "wait", why: `start window passed; refundable ${when(deadline, now)}` };
  }
  if (f.tablePhase === TABLE_PHASE.waiting) {
    if (now > f.startDeadline) return { do: "claim_timeout", why: "a Player never checked in before the start deadline" };
    if (!f.seatsOpen) return { do: "seat_players", why: "Match begun, seats not handed to the Players" };
    return { do: "wait", why: `waiting for check-ins until ${when(f.startDeadline, now)}` };
  }
  // Live
  if (f.pendingKind !== PENDING.none) {
    if (slot > f.pendingSlot) return { do: "resolve", why: `declared action (kind ${f.pendingKind}) waiting since slot ${f.pendingSlot}` };
    return { do: "wait", why: `action declared in slot ${f.pendingSlot}, resolvable from the next slot` };
  }
  if (f.status === STATUS.setup) {
    const at = Math.min(f.entropyDeadline, f.setupDeadline) + GRACE_SECS;
    if (now > at) return { do: "claim_timeout", why: "setup past its entropy deadline" };
    return { do: "assist_setup", why: `in setup, cancellable ${when(at + 1, now)}` };
  }
  if (f.status === STATUS.live) {
    const turnAt = f.deadline + GRACE_SECS;
    const capAt = f.capDeadline + GRACE_SECS;
    if (now > capAt) return { do: "claim_timeout", why: "time cap passed" };
    if (now > turnAt) return { do: "claim_timeout", why: "turn expired and nobody claimed it" };
    return { do: "wait", why: `live, turn ends ${when(f.deadline, now)}, keeper steps in ${when(turnAt + 1, now)}` };
  }
  return { do: "wait", why: `table live, battle status ${f.status}` };
}

/** Facts for `vanguardStep` from the Assignment, the table and its Battle in the rollup, and base's copy of the table. */
export function vanguardFacts(a: Assignment | null, live: TableState | null, b: Battle | null, base: TableState | null, nowS: number): VanguardFacts {
  const ours = !!a && !!live && tableOf(a, live) && !!b && b.tesoroMatch.equals(a.tesoroMatch);
  return {
    assigned: !!a,
    ours,
    tablePhase: live?.phase ?? TABLE_PHASE.idle,
    seatsOpen: live?.seatsOpen ?? false,
    dirty: live?.dirty ?? false,
    startDeadline: a?.startDeadline ?? 0,
    status: b?.status ?? STATUS.created,
    entropyDeadline: b?.entropyDeadline ?? 0,
    setupDeadline: b?.setupDeadline ?? 0,
    deadline: b?.deadline ?? 0,
    capDeadline: b?.capDeadline ?? 0,
    pendingKind: b?.pendingKind ?? PENDING.none,
    pendingSlot: b?.pendingSlot ?? 0n,
    finalizable: !!a && !!base && canFinalizeTable(base, a, nowS),
  };
}

export type SetupMove = "deal" | "request_vrf" | "wait";

/**
 * Setup the Players' clients did not finish. The Armies are never read, so what is possible comes from simulations:
 * `canDeal` (the deal would go through: both secrets and the randomness are in) wins; `canRequest` (the request
 * would go through: both secrets are in and the Match's one request was not made) asks for the randomness, no sooner
 * than SETUP_ASSIST_SECS into setup. The request is made once per Match; a lost answer ends in a cancel and a refund.
 */
export function setupMove(i: { canDeal: boolean; canRequest: boolean; now: number; setupStartedAt: number }): SetupMove {
  if (i.canDeal) return "deal";
  if (!i.canRequest || i.now < i.setupStartedAt + SETUP_ASSIST_SECS) return "wait";
  return "request_vrf";
}

// ---- tables ------------------------------------------------------------------------------------

/** Rollup facts for one table; `receiptAge(match)` is the age in seconds of tesoro_core's settlement receipt, or `null` if there is none. */
export function vanguardTableFacts(t: TableState, nowS: number, receiptAge: (match: PublicKey) => number | null, base: TableState | null = null, lastRecommit = 0): HoldemTableFacts {
  const doneSlots = t.ring
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.state === SLOT.done)
    .map(({ s, index }) => ({ index, match: s.tesoroMatch.toBase58(), receiptOld: (receiptAge(s.tesoroMatch) ?? -1) >= 60 }));
  const onMatch = t.phase === TABLE_PHASE.waiting || t.phase === TABLE_PHASE.live;
  return {
    tablePhase: t.phase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    sinceOver: t.phase === TABLE_PHASE.over ? Math.max(0, Math.floor(nowS - t.overAt)) : 0,
    doneSlots,
    matchFrozen: onMatch && (receiptAge(t.tesoroMatch) ?? -1) >= 60,
    recommit: needsRecommit(t, base, nowS, lastRecommit),
  };
}

/** Vanguard hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function vanguard(ctx: Ctx, match: PublicKey, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[vanguard ${st}]`;
  let actions = 0;

  if (st === "open") {
    if (now < deadline) log("match", subject, `${tag} wait: no opponent yet, refundable ${when(deadline, now)}`);
    else return actions + +(await refund(ctx, m, subject, "no opponent before deadline")).ok;
    return actions;
  }

  const a = await ctx.vanguard.readAssignment(match);
  const live = a ? await ctx.vanguard.readTable(ctx.hsigner, a).catch(() => null) : null;
  const base = a ? await ctx.vanguard.readTableOnBase(a).catch(() => null) : null;
  const ours = !!a && !!live && tableOf(a, live);
  const battle = a && ours ? await ctx.vanguard.readBattle(ctx.hsigner, a).catch(() => null) : null;
  const tee: Connection | null = a ? await ctx.vanguard.teeConnection(ctx.hsigner).catch(() => null) : null;
  const slot = tee ? BigInt(await tee.getSlot().catch(() => 0)) : 0n;
  const step = vanguardStep(vanguardFacts(a, live, battle, base, now), now, deadline, slot);

  // Table upkeep, assignment and commits belong to the table scheduler (scheduler.ts); this hook drives the Match on its table.
  if (step.do === "assign") {
    log("match", subject, `${tag} wait: the table scheduler assigns a table`);
    return actions;
  }
  if (step.do === "refund") return actions + +(await refund(ctx, m, subject, step.why)).ok;
  if (!a) return actions;
  const send = (what: string, fn: () => Promise<string>) => act(ctx, "match", subject, `${what} (${step.why})`, fn);
  if (step.do === "finalize") return actions + +(await send("finalize", () => ctx.vanguard.finalize(ctx.hsigner, a))).ok;
  if (step.do === "begin_match") return actions + +(await send("begin_match", () => ctx.vanguard.beginMatch(ctx.hsigner, a))).ok;
  if (step.do === "seat_players") return actions + +(await send("seat_players", () => ctx.vanguard.seatPlayers(ctx.hsigner, a))).ok;
  if (step.do === "resolve") return actions + +(await send("resolve", () => ctx.vanguard.resolve(ctx.hsigner, a))).ok;
  if (step.do === "assist_setup" && battle && tee) return actions + (await assistSetup(ctx, a, battle, tee, subject, tag));
  if (step.do === "claim_timeout" && tee) {
    const ix = await ctx.vanguard.claimTimeoutIx(ctx.payer.publicKey, a);
    const why = await simulate(tee, ctx.payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix]);
    if (why) {
      log("match", subject, `${tag} wait: claim_timeout not yet possible (${why.slice(0, 120)}), retrying next pass`);
      return actions;
    }
    return actions + +(await send("claim_timeout", () => ctx.vanguard.claimTimeout(ctx.hsigner, a))).ok;
  }
  log("match", subject, `${tag} wait: ${step.why}`);
  return actions;
}

/** Deals, or asks for the randomness, when the Players' clients have not. Sends nothing a simulation refuses. */
async function assistSetup(ctx: Ctx, a: Assignment, b: Battle, tee: Connection, subject: string, tag: string): Promise<number> {
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: CU.resolve });
  const deal = await ctx.vanguard.dealIx(ctx.payer.publicKey, a);
  const canDeal = !(await simulate(tee, ctx.payer, [limit, deal]));
  const request = canDeal ? null : await ctx.vanguard.requestVrfIx(ctx.payer.publicKey, a, b.oracleQueue);
  const canRequest = request ? !(await simulate(tee, ctx.payer, [request])) : false;
  const move = setupMove({ canDeal, canRequest, now: ctx.now, setupStartedAt: b.entropyDeadline - ENTROPY_SECS });
  if (move === "deal") return +(await act(ctx, "match", subject, "deal (both secrets and the randomness are in)", () => ctx.vanguard.deal(ctx.hsigner, a))).ok;
  if (move === "request_vrf") {
    return +(await act(ctx, "match", subject, "request_vrf (both secrets are in, no request yet)", () => ctx.vanguard.requestVrf(ctx.hsigner, a, b.oracleQueue))).ok;
  }
  log("match", subject, `${tag} wait: setup in progress`);
  return 0;
}
