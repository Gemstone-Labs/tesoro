import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { ASSETS, STATUS, TRADING_DUEL_PROGRAM_ID, addresses, assetOfMatchId, decodeDuel } from "../../app/src/games/trading-duel/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { refund } from "./blockpuzzle.ts";
import { shortKey } from "./env.ts";
import { simulate, when } from "./tee.ts";


/** Seconds past `ends_at` before the keeper ends a Match itself, so the Players' clients get the first try. */
export const END_GRACE_SECS = Number(process.env.KEEPER_DUEL_END_GRACE_SECS ?? 2);

export interface DuelFacts {
  status: number;
  finalized: boolean;
  startDeadline: number;
  startsAt: number;
  endsAt: number;
}

export type DuelStep = { do: "finalize" | "claim_timeout" | "tick" | "end_match" | "close_match" | "refund" | "wait"; why: string };

/**
 * What to do with a Duel. `layer` says where its state was read:
 *  - "base": owned by the Game (never delegated, or committed back): only `finalize` moves it.
 *  - "tee": delegated; the rollup enforces its own clocks (`end_match` is refused before its `ends_at`, so the caller
 *    simulates it and waits when the rollup clock is behind). While the grid runs the keeper adds one
 *    `tick` per pass: the Players' apps tick about once a second, this only keeps the line from going quiet when
 *    both are away.
 * A Duel left Created is finalized (refund) or cancelled once its 5-minute start deadline passes; tesoro_core's own
 * deadline was pushed out 24 h at `create_match`.
 */
export function duelStep(d: DuelFacts, layer: "base" | "tee", now: number, deadline: number): DuelStep {
  if (layer === "base") {
    if (d.finalized) return { do: "wait", why: "already finalized" };
    if (d.status === STATUS.over || d.status === STATUS.cancelled) return { do: "finalize", why: `Duel ${d.status === STATUS.over ? "over" : "cancelled"}` };
    if (d.status === STATUS.created) {
      if (now > d.startDeadline) return { do: "finalize", why: "no-show: never delegated before its start deadline, refunds both entries" };
      return { do: "wait", why: `created, not delegated; finalize refunds ${when(d.startDeadline + 1, now)}` };
    }
    if (now >= deadline) return { do: "refund", why: "Duel never finished before the Match deadline" };
    return { do: "wait", why: `Duel on base layer (status ${d.status}), refundable ${when(deadline, now)}` };
  }
  if (d.status === STATUS.created) {
    if (now > d.startDeadline) return { do: "claim_timeout", why: "delegated but never started before its start deadline" };
    return { do: "wait", why: `delegated, not started; cancellable ${when(d.startDeadline + 1, now)}` };
  }
  if (d.status === STATUS.live) {
    const at = d.endsAt + END_GRACE_SECS;
    if (now >= d.startsAt && now < d.endsAt) return { do: "tick", why: `grid running until ${when(d.endsAt, now)}` };
    if (now >= at) return { do: "end_match", why: "grid closed and nobody ended it" };
    return { do: "wait", why: `live, ends ${when(d.endsAt, now)}, keeper steps in ${when(at, now)}` };
  }
  if (d.status === STATUS.over || d.status === STATUS.cancelled) return { do: "close_match", why: `Duel ${d.status === STATUS.over ? "over" : "cancelled"}, still in the rollup` };
  return { do: "wait", why: `status ${d.status}` };
}

/** Trading Duel hygiene for one unsettled tesoro_core Match. Returns the number of actions taken. */
export async function tradingDuel(ctx: Ctx, id: bigint, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[trading-duel ${st}]`;
  const ad = addresses(id);
  const info = await ctx.conn.getAccountInfo(ad.duel);

  if (!info) {
    if (now < deadline) {
      log("match", subject, `${tag} wait: no Duel yet, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, st === "open" ? "no opponent before deadline" : "no Duel before deadline")).ok;
  }

  if (info.owner.equals(TRADING_DUEL_PROGRAM_ID)) {
    const d = decodeDuel(ad.duel, ctx.duel.program.coder.accounts.decode("duel", info.data));
    const step = duelStep(d, "base", now, deadline);
    if (step.do === "finalize") return +(await act(ctx, "match", subject, `finalize (${step.why})`, () => ctx.duel.finalize(ctx.hsigner, id))).ok;
    if (step.do === "refund") return +(await refund(ctx, id, subject, step.why)).ok;
    log("match", subject, `${tag} wait: ${step.why}`);
    return 0;
  }
  if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    log("match", subject, `${tag} SKIP: Duel owned by ${shortKey(info.owner)}`);
    return 0;
  }

  // Delegated: the Duel is public in the rollup, read it with the keeper's token.
  const d = await ctx.duel.readDuel(ctx.hsigner, id).catch(() => null);
  if (!d) {
    log("match", subject, `${tag} wait: Duel not readable in the rollup yet`);
    return 0;
  }
  const step = duelStep(d, "tee", now, deadline);
  const tee = await ctx.duel.teeConnection(ctx.hsigner);
  const asset = assetOfMatchId(id) ?? ASSETS[d.asset.id];

  if (step.do === "claim_timeout") {
    return +(await act(ctx, "match", subject, `claim_timeout (${step.why})`, () => ctx.duel.claimTimeout(ctx.hsigner, id))).ok;
  }
  if (step.do === "tick") {
    return +(await act(ctx, "match", subject, `tick (${step.why})`, () => ctx.duel.tick(ctx.hsigner, id, asset))).ok;
  }
  if (step.do === "end_match") {
    const endIx = await ctx.duel.program.methods
      .endMatch()
      .accountsPartial({ caller: ctx.payer.publicKey, duel: ad.duel, book0: ad.book0, book1: ad.book1 } as any)
      .instruction();
    const why = await simulate(tee, ctx.payer, [endIx]);
    if (why) {
      log("match", subject, `${tag} wait: end_match not yet possible (${why.slice(0, 120)}), retrying next pass`);
      return 0;
    }
    return +(await act(ctx, "match", subject, `end_match (${step.why})`, () => ctx.duel.end(ctx.hsigner, id))).ok;
  }
  if (step.do === "close_match") {
    return +(
      await act(ctx, "match", subject, `close_match (${step.why}) then finalize`, async () => {
        await ctx.duel.closeMatch(ctx.hsigner, id);
        return ctx.duel.finalize(ctx.hsigner, id);
      })
    ).ok;
  }
  log("match", subject, `${tag} wait: ${step.why}`);
  return 0;
}
