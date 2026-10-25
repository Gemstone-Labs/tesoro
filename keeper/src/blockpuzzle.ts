import { act, type Ctx } from "./act.ts";
import { refundMatchIx } from "./core-ix.ts";
import { keyOf, matchAddress, matchRefOf } from "./kit.ts";
import { sendIxs } from "./send.ts";

/** Starts a refund of a Match whose deadline passed (core lets anyone); the settle job then runs its chunks. `m` is the decoded `MatchState.inner`. */
export const refund = (ctx: Ctx, m: any, subject: string, why: string) =>
  act(ctx, "match", subject, `refund_match (${why})`, async () => {
    const ix = await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: keyOf(m.game), matchState: matchAddress(matchRefOf(m.id)) });
    return sendIxs(ctx.conn, ctx.payer, [ix], { units: 300_000 });
  });
