import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { VANGUARD_PROGRAM_ID, CU, addresses } from "../../app/src/games/vanguard/chain.ts";
import { PENDING, STATUS, decodeBattle } from "../../app/src/games/vanguard/decode.ts";
import { commitInFlight, commits, noteClose } from "./commits.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { shortKey } from "./env.ts";
import { simulate, when } from "./tee.ts";

/** Seconds past an expired turn or the time cap before the keeper claims it, so the Players' clients get the first try. */
export const GRACE_SECS = Number(process.env.KEEPER_VANGUARD_GRACE_SECS ?? 2);

export interface BattleFacts {
  status: number;
  finalized: boolean;
  /** The Battle has permissions, so closing it takes `close_match` rather than `close_unstarted`. */
  permissioned: boolean;
  startDeadline: number;
  entropyDeadline: number;
  setupDeadline: number;
  deadline: number;
  capDeadline: number;
  pendingKind: number;
  pendingSlot: bigint;
}

export type VanguardStep = {
  do: "finalize" | "refund" | "resolve" | "claim_timeout" | "close_match" | "close_unstarted" | "wait";
  why: string;
};

/**
 * What to do with a Battle. `layer` says where it was read; `slot` is the rollup's current slot (ignored on base).
 *  - "base": only `finalize` moves it; a Battle stuck there is refunded through tesoro_core at the Match deadline.
 *  - "tee": a declared action comes first: any caller may `resolve` it from a later slot than its declare, and
 *    while one is pending nothing else is accepted. Then the start, setup, turn and cap clocks: each is a
 *    `claim_timeout` (a cancel, or a declare of a lost turn that the next pass resolves) once GRACE_SECS past.
 *    The rollup clock may be behind the base clock, so the caller simulates `claim_timeout` and waits if refused.
 */
export function vanguardStep(b: BattleFacts, layer: "base" | "tee", now: number, deadline: number, slot: bigint): VanguardStep {
  if (layer === "base") {
    if (b.finalized) return { do: "wait", why: "already finalized" };
    if (b.status === STATUS.over || b.status === STATUS.cancelled) return { do: "finalize", why: `Battle ${b.status === STATUS.over ? "over" : "cancelled"}` };
    if (b.status === STATUS.created) {
      if (now > b.startDeadline) return { do: "finalize", why: "no-show: never delegated before its start deadline, refunds both entries" };
      return { do: "wait", why: `created, not delegated; finalize refunds ${when(b.startDeadline + 1, now)}` };
    }
    if (now >= deadline) return { do: "refund", why: "Battle never finished before the Match deadline" };
    return { do: "wait", why: `Battle on base layer (status ${b.status}), refundable ${when(deadline, now)}` };
  }
  if (b.pendingKind !== PENDING.none) {
    if (slot > b.pendingSlot) return { do: "resolve", why: `declared action (kind ${b.pendingKind}) waiting since slot ${b.pendingSlot}` };
    return { do: "wait", why: `action declared in slot ${b.pendingSlot}, resolvable from the next slot` };
  }
  if (b.status === STATUS.created) {
    if (now > b.startDeadline) return { do: "claim_timeout", why: "delegated but never started before its start deadline" };
    return { do: "wait", why: `delegated, not started; cancellable ${when(b.startDeadline + 1, now)}` };
  }
  if (b.status === STATUS.setup) {
    const at = Math.min(b.entropyDeadline, b.setupDeadline) + GRACE_SECS;
    if (now > at) return { do: "claim_timeout", why: "setup past its entropy deadline" };
    return { do: "wait", why: `in setup, cancellable ${when(at + 1, now)}` };
  }
  if (b.status === STATUS.live) {
    const turnAt = b.deadline + GRACE_SECS;
    const capAt = b.capDeadline + GRACE_SECS;
    if (now > capAt) return { do: "claim_timeout", why: "time cap passed" };
    if (now > turnAt) return { do: "claim_timeout", why: "turn expired and nobody claimed it" };
    return { do: "wait", why: `live, turn ends ${when(b.deadline, now)}, keeper steps in ${when(turnAt + 1, now)}` };
  }
  if (b.status === STATUS.over || b.status === STATUS.cancelled) {
    const what = b.status === STATUS.over ? "over" : "cancelled";
    if (b.status === STATUS.cancelled && !b.permissioned) return { do: "close_unstarted", why: `Battle ${what} before permissions, still in the rollup` };
    return { do: "close_match", why: `Battle ${what}, still in the rollup` };
  }
  return { do: "wait", why: `status ${b.status}` };
}

/** Vanguard hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function vanguard(ctx: Ctx, id: bigint, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[vanguard ${st}]`;
  const ad = addresses(id);
  const info = await ctx.conn.getAccountInfo(ad.battle);

  if (!info) {
    if (now < deadline) {
      log("match", subject, `${tag} wait: no Battle yet, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, st === "open" ? "no opponent before deadline" : "no Battle before deadline")).ok;
  }

  if (info.owner.equals(VANGUARD_PROGRAM_ID)) {
    const b = decodeBattle(info.data);
    commits.clear(subject);
    const step = vanguardStep(factsOf(b), "base", now, deadline, 0n);
    if (step.do === "finalize") return +(await act(ctx, "match", subject, `finalize (${step.why})`, () => ctx.vanguard.finalize(ctx.hsigner, id))).ok;
    if (step.do === "refund") return +(await refund(ctx, id, subject, step.why)).ok;
    log("match", subject, `${tag} wait: ${step.why}`);
    return 0;
  }
  if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    log("match", subject, `${tag} SKIP: Battle owned by ${shortKey(info.owner)}`);
    return 0;
  }

  // Delegated: the Battle is public in the rollup, read it with the keeper's token. Armies and the Secret are never read.
  const b = await ctx.vanguard.readBattle(ctx.hsigner, id).catch(() => null);
  if (!b) {
    log("match", subject, `${tag} wait: Battle not readable in the rollup yet`);
    return 0;
  }
  const tee = await ctx.vanguard.teeConnection(ctx.hsigner);
  const slot = BigInt(await tee.getSlot().catch(() => 0));
  const step = vanguardStep(factsOf(b), "tee", now, deadline, slot);

  if (step.do === "resolve") return +(await act(ctx, "match", subject, `resolve (${step.why})`, () => ctx.vanguard.resolve(ctx.hsigner, id))).ok;
  if (step.do === "claim_timeout") {
    const ix = await ctx.vanguard.program.methods
      .claimTimeout()
      .accountsPartial({ caller: ctx.payer.publicKey, battle: ad.battle, secret: ad.secret } as any)
      .instruction();
    const why = await simulate(tee, ctx.payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix]);
    if (why) {
      log("match", subject, `${tag} wait: claim_timeout not yet possible (${why.slice(0, 120)}), retrying next pass`);
      return 0;
    }
    return +(await act(ctx, "match", subject, `claim_timeout (${step.why})`, () => ctx.vanguard.claimTimeout(ctx.hsigner, id))).ok;
  }
  if (step.do === "close_match" || step.do === "close_unstarted") {
    const teeInfo = await tee.getAccountInfo(ad.battle).catch(() => null);
    if (commitInFlight(subject, tag, teeInfo?.owner ?? null)) return 0;
    const r = await act(ctx, "match", subject, `${step.do} (${step.why})`, () =>
      step.do === "close_match" ? ctx.vanguard.closeMatch(ctx.hsigner, id).then((x) => x.tee) : ctx.vanguard.closeUnstarted(ctx.hsigner, id),
    );
    noteClose(subject, tag, r);
    return +r.ok;
  }
  log("match", subject, `${tag} wait: ${step.why}`);
  return 0;
}

function factsOf(b: ReturnType<typeof decodeBattle>): BattleFacts {
  return {
    status: b.status,
    finalized: b.finalized !== 0,
    permissioned: b.permissioned !== 0,
    startDeadline: b.startDeadline,
    entropyDeadline: b.entropyDeadline,
    setupDeadline: b.setupDeadline,
    deadline: b.deadline,
    capDeadline: b.capDeadline,
    pendingKind: b.pendingKind,
    pendingSlot: b.pendingSlot,
  };
}
