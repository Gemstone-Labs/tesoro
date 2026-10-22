import { PublicKey } from "@solana/web3.js";
import { protectionsPda } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";
import { clearRequestIx, expireOfferIx, refundMatchIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { keyOf, matchAddress, matchLabel, matchRefOf, type MatchRef } from "./kit.ts";
import { sendIxs } from "./send.ts";

const status = (o: object) => Object.keys(o)[0];
const secs = (n: { toString(): string }) => Number(n.toString());

export type AwayAction =
  | { kind: "refund"; match: MatchRef; game: PublicKey; account: string }
  | { kind: "clear-request"; request: PublicKey; account: string }
  | { kind: "withdraw-offer"; offer: PublicKey; account: string };

/** The Accounts on a Break or Self-Excluded at `now`, from decoded `ProtectionsState` accounts. */
export function awayAccounts(protections: { account: PublicKey; inner: { breakUntil: { toString(): string }; selfExclusionUntil: { toString(): string } } }[], now: number): Set<string> {
  return new Set(
    protections
      .filter((p) => now < secs(p.inner.breakUntil) || now < secs(p.inner.selfExclusionUntil))
      .map((p) => p.account.toBase58()),
  );
}

/** A Match as the plan reads it: its id, stage, Game and the Account that opened it. */
export interface AwayMatch {
  ref: MatchRef;
  stage: string;
  game: PublicKey;
  opener: PublicKey;
}

/**
 * What anyone may clean up for Players who are away: unpaired (Open) Matches are refunded, open Requests withdrawn and
 * unused (Open or Accepted) Offers of away Backers released. Paired Matches are left to play out.
 */
export function planAway(
  away: Set<string>,
  matches: AwayMatch[],
  requests: { publicKey: PublicKey; account: { inner: { status: object; player: ArrayLike<number> } } }[],
  offers: { publicKey: PublicKey; account: { inner: { status: object; backer: ArrayLike<number> } } }[],
): AwayAction[] {
  const plan: AwayAction[] = [];
  if (away.size === 0) return plan;
  for (const m of matches) {
    if (m.stage === "open" && away.has(m.opener.toBase58())) plan.push({ kind: "refund", match: m.ref, game: m.game, account: m.opener.toBase58() });
  }
  for (const r of requests) {
    const account = keyOf(r.account.inner.player).toBase58();
    if (status(r.account.inner.status).toLowerCase() === "open" && away.has(account)) plan.push({ kind: "clear-request", request: r.publicKey, account });
  }
  for (const o of offers) {
    const account = keyOf(o.account.inner.backer).toBase58();
    if (["open", "accepted"].includes(status(o.account.inner.status).toLowerCase()) && away.has(account)) plan.push({ kind: "withdraw-offer", offer: o.publicKey, account });
  }
  return plan;
}

/**
 * Job: Break and Self-Exclusion clean-up (ADR 0012 Protections). The app's set flow withdraws a Player's own things first,
 * so this only catches what a direct transaction or a race left behind. Every step is permissionless on chain: with the
 * opener's Protections account `refund_match` starts an Open Match's refund at once, and `expire_offer` with the Backer's
 * Protections cancels the Offer instead of waiting for its expiry.
 */
export async function awayCleanup(ctx: Ctx): Promise<number> {
  const protections: any[] = await ctx.core.account.protectionsState.all();
  const away = awayAccounts(protections.map((p) => ({ account: p.account.account, inner: p.account.inner })), ctx.now);
  if (away.size === 0) return 0;
  const [matches, requests, offers]: any[][] = await Promise.all([ctx.core.account.matchState.all(), ctx.core.account.requestState.all(), ctx.core.account.offerState.all()]);
  const plan = planAway(
    away,
    matches.map(({ account }) => ({ ref: matchRefOf(account.inner.id), stage: status(account.inner.stage).toLowerCase(), game: keyOf(account.inner.game), opener: keyOf(account.inner.a.player) })),
    requests,
    offers,
  );
  let actions = 0;
  for (const step of plan) {
    const owner = new PublicKey(step.account);
    const protectionsKey = protectionsPda(owner);
    if (step.kind === "refund") {
      const r = await act(ctx, "away", `match=${matchLabel(step.match)}`, `refund_match (opener ${shortKey(owner)} is away)`, async () =>
        sendIxs(ctx.conn, ctx.payer, [await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: step.game, matchState: matchAddress(step.match), openerProtections: protectionsKey })], { units: 300_000 }),
      );
      actions += +r.ok;
    } else if (step.kind === "clear-request") {
      const r = await act(ctx, "away", `request=${shortKey(step.request)}`, `clear_request (owner ${shortKey(owner)} is away)`, async () =>
        sendIxs(ctx.conn, ctx.payer, [await clearRequestIx(ctx.core, { caller: ctx.payer.publicKey, request: step.request, protections: protectionsKey })]),
      );
      actions += +r.ok;
    } else {
      const offer: any = offers.find((o) => o.publicKey.equals(step.offer))!.account;
      const accepted = status(offer.inner.status).toLowerCase() === "accepted" && offer.inner.request;
      const r = await act(ctx, "away", `offer=${shortKey(step.offer)}`, `expire_offer (Backer ${shortKey(owner)} is away)`, async () =>
        sendIxs(ctx.conn, ctx.payer, [await expireOfferIx(ctx.core, { caller: ctx.payer.publicKey, backerAccount: owner, offer: step.offer, request: accepted ? keyOf(offer.inner.request) : null, backerProtections: protectionsKey })]),
      );
      actions += +r.ok;
    }
  }
  log("away", "-", `${away.size} away Account(s), ${plan.length} clean-up step(s), ${actions} done`);
  return actions;
}
