import { act, log, type Ctx } from "./act.ts";
import { expireOfferIx } from "./core-ix.ts";
import { shortKey } from "./env.ts";
import { keyOf } from "./kit.ts";
import { sendIxs } from "./send.ts";

const status = (o: object) => Object.keys(o)[0].toLowerCase();

/** Offers anyone may expire at `now`: an Open one past `expires_at`, an Accepted one past `use_by`. A Backing Ticket on it is cancelled first (the Ticket job). */
export function lapsedOffers(offers: { publicKey: unknown; account: any }[], now: number) {
  return offers.flatMap(({ publicKey, account }) => {
    const o = account.inner;
    const st = status(o.status);
    const due = st === "open" ? Number(o.expiresAt.toString()) : st === "accepted" ? Number(o.useBy.toString()) : null;
    return due === null ? [] : [{ publicKey, account, st, due, late: now >= due, ticketOpen: !!o.ticketOpen }];
  });
}

/**
 * Job 2: Backing hygiene. tesoro_core has `expire_offer` (permissionless) which releases the Backer's reserved Gemas
 * (an amount, not lines) once an Open Offer passed `expires_at` or an Accepted one passed `use_by`. An Offer with a Backing
 * Ticket open waits until the Ticket is cancelled. Requests hold no reservation and have no expiry instruction (only the
 * Player can `cancel_request`); they are counted, not acted on.
 */
export async function backingHygiene(ctx: Ctx): Promise<number> {
  const now = ctx.now;
  let actions = 0;
  const offers: any[] = await ctx.core.account.offerState.all();
  const pending = lapsedOffers(offers, now);
  for (const o of pending) {
    const subject = `offer=${shortKey(o.publicKey as any)}`;
    if (!o.late) {
      log("backing", subject, `wait: ${o.st} offer, expires in ${o.due - now}s`);
      continue;
    }
    if (o.ticketOpen) {
      log("backing", subject, "wait: a Backing Ticket is open on it (the Ticket job cancels it first)");
      continue;
    }
    const inner = o.account.inner;
    const r = await act(ctx, "backing", subject, `expire_offer (${o.st} offer lapsed ${now - o.due}s ago)`, async () =>
      sendIxs(ctx.conn, ctx.payer, [
        await expireOfferIx(ctx.core, {
          caller: ctx.payer.publicKey,
          backerAccount: keyOf(inner.backer),
          offer: o.publicKey as any,
          // An accepted Offer hands its Request back to Open, so the Request comes with the call.
          request: o.st === "accepted" && inner.request ? keyOf(inner.request) : null,
        }),
      ]),
    );
    actions += +r.ok;
  }
  const requests: any[] = await ctx.core.account.requestState.all();
  const lapsed = requests.filter((r) => status(r.account.inner.status) === "open" && Number(r.account.inner.expiresAt.toString()) <= now).length;
  log("backing", "-", `${offers.length} offers (${pending.length} open/accepted), ${requests.length} requests (${lapsed} lapsed, no permissionless expiry instruction), ${actions} action(s)`);
  return actions;
}
