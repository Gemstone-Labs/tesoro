import { PublicKey } from "@solana/web3.js";
import { atAssignedEpoch } from "../../app/src/lib/chain/table-epoch.ts";
import { PHASE, bookPda, canFinalizeTable, decodeDuel, type Assignment, type Table } from "../../app/src/games/trading-duel/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { simulate, when } from "./tee.ts";

/** Seconds past `ends_at` before the keeper ends a Match itself, so the Players' clients get the first try. */
export const END_GRACE_SECS = Number(process.env.KEEPER_DUEL_END_GRACE_SECS ?? 2);

export interface DuelFacts {
  /** The Assignment exists. */
  assigned: boolean;
  /** The table's turn is this Match's (same epoch and Match); false when the table moved on, cannot be read, or runs another Match. */
  ours: boolean;
  phase: number;
  seatsOpen: boolean;
  dirty: boolean;
  startDeadline: number;
  startsAt: number;
  endsAt: number;
  /** Base's committed copy of the table can settle the Match (a Done result, or the table is past the epoch). */
  finalizable: boolean;
}

export type DuelStep = {
  do: "assign" | "finalize" | "begin_match" | "open_seats" | "expire_start" | "tick" | "end_match" | "commit_table" | "refund" | "wait";
  why: string;
};

/**
 * What to do with one unsettled Trading Duel Match. Table upkeep after the Match (closing the seats, resetting, freeing ring
 * slots) is not a Match step: it is the table scheduler's (`scheduler.ts`).
 *  - No Assignment: the table scheduler binds the Match to an Idle table (`assign`), while the Match is young enough to start.
 *  - Base's committed table can settle the Match: `finalize`, whatever else is going on.
 *  - Idle at the Match's epoch: `begin_match`. Waiting with the seats closed: `open_seats`. Both Players then check in (their
 *    clients); past the start deadline with one missing: `expire_start`, which ends it in the ring (the Player who checked in wins; nobody did: a no-show).
 *  - Live: one `tick` per pass while the grid runs (the Players' apps tick about four times a second; this only keeps the line
 *    from going quiet when both are away), `end_match` once the window closed and the Players had their first try.
 *  - Over and not committed: the table scheduler commits it (`commit_table`; the table is `dirty` until then, so once per result).
 *  - Anything else: wait for tesoro_core's own refund at the Match deadline.
 */
export function duelStep(d: DuelFacts, now: number, deadline: number): DuelStep {
  if (!d.assigned) {
    if (now >= deadline) return { do: "refund", why: "no table was assigned before the Match deadline" };
    return { do: "assign", why: "the Match has no table yet" };
  }
  if (d.finalizable) return { do: "finalize", why: "the committed table holds the result" };
  if (!d.ours) {
    if (now >= deadline) return { do: "refund", why: "the table never settled the Match before the Match deadline" };
    return { do: "wait", why: `table is on another Match or epoch; refundable ${when(deadline, now)}` };
  }
  if (d.phase === PHASE.idle) {
    if (now <= d.startDeadline) return { do: "begin_match", why: "assigned table is Idle at the Match's epoch" };
    return { do: "wait", why: `start window passed; refundable ${when(deadline, now)}` };
  }
  if (d.phase === PHASE.waiting) {
    if (now > d.startDeadline) return { do: "expire_start", why: "a Player never checked in before the start deadline" };
    if (!d.seatsOpen) return { do: "open_seats", why: "Match begun, Books not created" };
    return { do: "wait", why: `waiting for check-ins until ${when(d.startDeadline, now)}` };
  }
  if (d.phase === PHASE.live) {
    const at = d.endsAt + END_GRACE_SECS;
    if (now >= d.startsAt && now < d.endsAt) return { do: "tick", why: `grid running until ${when(d.endsAt, now)}` };
    if (now >= at) return { do: "end_match", why: "grid closed and nobody ended it" };
    return { do: "wait", why: `live, ends ${when(d.endsAt, now)}, keeper steps in ${when(at, now)}` };
  }
  if (d.phase === PHASE.over && d.dirty) return { do: "commit_table", why: "the result is not committed yet" };
  return { do: "wait", why: `committed, waiting for the base layer to show it; refundable ${when(deadline, now)}` };
}

/** Facts for `duelStep` from the Assignment, the table in the rollup and base's copy of it. */
export function duelFacts(a: Assignment | null, live: Table | null, base: Table | null, nowS: number): DuelFacts {
  const duel = a && live ? decodeDuel(a, live) : null;
  return {
    assigned: !!a,
    ours: !!duel || (!!a && !!live && live.phase === PHASE.idle && atAssignedEpoch(a, live)),
    phase: live?.phase ?? PHASE.idle,
    seatsOpen: live?.seatsOpen ?? false,
    dirty: live?.dirty ?? false,
    startDeadline: a?.startDeadline ?? 0,
    startsAt: live?.startsAt ?? 0,
    endsAt: live?.endsAt ?? 0,
    finalizable: !!a && !!base && canFinalizeTable(base, a, nowS),
  };
}

/** Trading Duel hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function tradingDuel(ctx: Ctx, match: PublicKey, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[trading-duel ${st}]`;
  let actions = 0;

  if (st === "open") {
    if (now < deadline) log("match", subject, `${tag} wait: no opponent yet, refundable ${when(deadline, now)}`);
    else return actions + +(await refund(ctx, m, subject, "no opponent before deadline")).ok;
    return actions;
  }

  const a = await ctx.duel.readAssignment(match);
  const live = a ? await ctx.duel.readTable(ctx.hsigner, a).catch(() => null) : null;
  const base = a ? await ctx.duel.readTableOnBase(a).catch(() => null) : null;
  const step = duelStep(duelFacts(a, live, base, now), now, deadline);

  // Table upkeep, assignment and commits belong to the table scheduler (scheduler.ts); this hook drives the Match on its table.
  if (step.do === "assign") {
    log("match", subject, `${tag} wait: the table scheduler assigns a table`);
    return actions;
  }
  if (step.do === "refund") return actions + +(await refund(ctx, m, subject, step.why)).ok;
  if (!a) return actions;
  if (step.do === "finalize") return actions + +(await act(ctx, "match", subject, `finalize (${step.why})`, () => ctx.duel.finalize(ctx.hsigner, a))).ok;
  if (step.do === "begin_match") return actions + +(await act(ctx, "match", subject, `begin_match (${step.why})`, () => ctx.duel.beginMatch(ctx.hsigner, a))).ok;
  if (step.do === "open_seats") return actions + +(await act(ctx, "match", subject, `open_seats (${step.why})`, () => ctx.duel.openSeats(ctx.hsigner, a))).ok;
  if (step.do === "expire_start") return actions + +(await act(ctx, "match", subject, `expire_start (${step.why})`, () => ctx.duel.expireStart(ctx.hsigner, a))).ok;
  if (step.do === "tick") return actions + +(await act(ctx, "match", subject, `tick (${step.why})`, () => ctx.duel.tick(ctx.hsigner, a, live!.asset))).ok;
  if (step.do === "end_match") {
    const tee = await ctx.duel.teeConnection(ctx.hsigner);
    const table = live!.address;
    const endIx = await ctx.duel.program.methods
      .endMatch()
      .accountsPartial({ caller: ctx.payer.publicKey, table, book0: bookPda(table, 0), book1: bookPda(table, 1) } as any)
      .instruction();
    const why = await simulate(tee, ctx.payer, [endIx]);
    if (why) {
      log("match", subject, `${tag} wait: end_match not yet possible (${why.slice(0, 120)}), retrying next pass`);
      return actions;
    }
    return actions + +(await act(ctx, "match", subject, `end_match (${step.why})`, () => ctx.duel.end(ctx.hsigner, a))).ok;
  }
  log("match", subject, `${tag} wait: ${step.why}`);
  return actions;
}
