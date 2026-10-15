import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { protectionsPda } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";

const status = (o: object) => Object.keys(o)[0];
const secs = (n: { toString(): string }) => Number(n.toString());
const keyOf = (bytes: ArrayLike<number>) => new PublicKey(Uint8Array.from(bytes)).toBase58();

export type AwayAction =
  | { kind: "refund"; id: bigint; account: string }
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

/**
 * What anyone may clean up for Players who are away: unpaired (Open) Matches are refunded, open Requests withdrawn and
 * unused (Open or Accepted) Offers of away Backers released. Paired Matches are left to play out.
 */
export function planAway(
  away: Set<string>,
  matches: { id: { toString(): string }; inner: { status: object; a: { player: ArrayLike<number> } } }[],
  requests: { publicKey: PublicKey; account: { inner: { status: object; player: ArrayLike<number> } } }[],
  offers: { publicKey: PublicKey; account: { inner: { status: object; backer: ArrayLike<number> } } }[],
): AwayAction[] {
  const plan: AwayAction[] = [];
  if (away.size === 0) return plan;
  for (const m of matches) {
    const account = keyOf(m.inner.a.player);
    if (status(m.inner.status) === "open" && away.has(account)) plan.push({ kind: "refund", id: BigInt(m.id.toString()), account });
  }
  for (const r of requests) {
    const account = keyOf(r.account.inner.player);
    if (status(r.account.inner.status) === "open" && away.has(account)) plan.push({ kind: "clear-request", request: r.publicKey, account });
  }
  for (const o of offers) {
    const account = keyOf(o.account.inner.backer);
    if (["open", "accepted"].includes(status(o.account.inner.status)) && away.has(account)) plan.push({ kind: "withdraw-offer", offer: o.publicKey, account });
  }
  return plan;
}

/**
 * Job: Break and Self-Exclusion clean-up (ADR 0011 Protections). The app's set flow withdraws a Player's own things first,
 * so this only catches what a direct transaction or a race left behind. Every step is permissionless on chain.
 */
export async function awayCleanup(ctx: Ctx): Promise<number> {
  const protections: any[] = await ctx.core.account.protectionsState.all();
  const away = awayAccounts(protections.map((p) => ({ account: p.account.account, inner: p.account.inner })), ctx.now);
  if (away.size === 0) return 0;
  const [matches, requests, offers]: any[][] = await Promise.all([
    ctx.core.account.matchState.all(),
    ctx.core.account.requestState.all(),
    ctx.core.account.offerState.all(),
  ]);
  const plan = planAway(away, matches.map((m) => m.account), requests, offers);
  let actions = 0;
  for (const step of plan) {
    const owner = new PublicKey(step.account);
    const protectionsKey = protectionsPda(owner);
    if (step.kind === "refund") {
      const r = await act(ctx, "away", `match=${step.id}`, `refund_match (opener ${shortKey(owner)} is away)`, () => ctx.bp.refundMatch(ctx.signer, step.id));
      actions += +r.ok;
    } else if (step.kind === "clear-request") {
      const r = await act(ctx, "away", `request=${shortKey(step.request)}`, `clear_request (owner ${shortKey(owner)} is away)`, async () => {
        const ix = await ctx.core.methods.clearRequest().accountsPartial({ caller: ctx.payer.publicKey, request: step.request, protections: protectionsKey }).instruction();
        return ctx.bp.sendBase(ctx.signer, [ix]);
      });
      actions += +r.ok;
    } else {
      const offer: any = offers.find((o) => o.publicKey.equals(step.offer))!.account;
      const accepted = status(offer.inner.status) === "accepted" && offer.inner.request;
      const holdings = offer.inner.lines.map((l: any) => ({ pubkey: BlockPuzzleChain.holding(owner, pk(l.source)), isSigner: false, isWritable: true }));
      const r = await act(ctx, "away", `offer=${shortKey(step.offer)}`, `expire_offer (Backer ${shortKey(owner)} is away)`, async () => {
        const ix = await ctx.core.methods
          .expireOffer()
          .accountsPartial({ caller: ctx.payer.publicKey, backerAccount: owner, offer: step.offer, request: accepted ? pk(offer.inner.request) : null, backerProtections: protectionsKey })
          .remainingAccounts(holdings)
          .instruction();
        return ctx.bp.sendBase(ctx.signer, [ix]);
      });
      actions += +r.ok;
    }
  }
  log("away", "-", `${away.size} away Account(s), ${plan.length} clean-up step(s), ${actions} done`);
  return actions;
}
