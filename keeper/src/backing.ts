import { BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";

const status = (o: object) => Object.keys(o)[0];

/**
 * Job 2: Backing hygiene. tesoro_core has `expire_offer` (permissionless) which releases the
 * Backer's reserved Gemas once an Open Offer passed `expires_at` or an Accepted one passed
 * `use_by`. Requests hold no reservation and have no expiry instruction (only the Player can
 * `cancel_request`); they are counted, not acted on.
 */
export async function backingHygiene(ctx: Ctx): Promise<number> {
  const now = ctx.now;
  let actions = 0;

  const offers: any[] = await ctx.core.account.offerState.all();
  let pending = 0;
  for (const { publicKey, account } of offers) {
    const o = account.inner;
    const st = status(o.status);
    const due = st === "open" ? Number(o.expiresAt.toString()) : st === "accepted" ? Number(o.useBy.toString()) : null;
    if (due === null) continue;
    pending++;
    const subject = `offer=${shortKey(publicKey)}`;
    if (now < due) {
      log("backing", subject, `wait: ${st} offer, expires in ${due - now}s`);
      continue;
    }
    // `backer` is already the Backer's TesoroAccount key (ledger identity), not the wallet.
    const backer = pk(o.backer);
    const holdings = o.lines.map((l: any) => ({
      pubkey: BlockPuzzleChain.holding(backer, pk(l.source)),
      isSigner: false,
      isWritable: true,
    }));
    const r = await act(ctx, "backing", subject, `expire_offer (${st} offer lapsed ${now - due}s ago, release ${o.lines.length} reserved line(s))`, async () => {
      const ix = await ctx.core.methods
        .expireOffer()
        .accountsPartial({
          caller: ctx.payer.publicKey,
          backerAccount: backer,
          offer: publicKey,
          // An accepted Offer hands its Request back to Open, so the Request comes with the call.
          request: st === "accepted" && o.request ? pk(o.request) : null,
          backerProtections: null,
        })
        .remainingAccounts(holdings)
        .instruction();
      return ctx.bp.sendBase(ctx.signer, [ix]);
    });
    actions += +r.ok;
  }

  const requests: any[] = await ctx.core.account.requestState.all();
  const lapsed = requests.filter((r) => status(r.account.inner.status) === "open" && Number(r.account.inner.expiresAt.toString()) <= now).length;
  log("backing", "-", `${offers.length} offers (${pending} open/accepted), ${requests.length} requests (${lapsed} lapsed, no permissionless expiry instruction), ${actions} action(s)`);
  return actions;
}
