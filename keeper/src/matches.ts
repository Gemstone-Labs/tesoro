import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { HOLDEM_PROGRAM_ID, STATUS, addresses as holdemAddresses, decodeTable } from "../../app/src/games/holdem/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { blockPuzzle, refund } from "./blockpuzzle.ts";
import { pk } from "./runtime.ts";
import { simulate, when } from "./tee.ts";

const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const status = (o: object) => Object.keys(o)[0];

/** Job 1: Match hygiene for every open or active Match in tesoro_core. Returns the number of actions taken. */
export async function matchHygiene(ctx: Ctx): Promise<number> {
  const all: any[] = await ctx.core.account.matchState.all();
  let actions = 0;
  let live = 0;
  for (const { account } of all) {
    const st = status(account.inner.status);
    if (st === "settled" || st === "refunded") continue;
    live++;
    const id = BigInt(account.id.toString());
    const game = pk(account.inner.game);
    const subject = `match=${id}`;
    try {
      if (game.equals(BLOCK_PUZZLE_PROGRAM_ID)) actions += await blockPuzzle(ctx, id, account.inner, st, subject);
      else if (game.equals(HOLDEM_PROGRAM_ID)) actions += await holdem(ctx, id, account.inner, st, subject);
      else log("match", subject, `SKIP unknown game ${shortKey(game)}`);
    } catch (e) {
      log("match", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  log("match", "-", `scanned ${all.length} Matches, ${live} unsettled, ${actions} action(s)`);
  return actions;
}

async function holdem(ctx: Ctx, id: bigint, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[holdem ${st.toLowerCase()}]`;
  const ad = holdemAddresses(id);
  const info = await ctx.conn.getAccountInfo(ad.gameMatch);

  if (!info) {
    if (now < deadline) {
      log("match", subject, `${tag} wait: no table yet, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, st === "open" ? "no opponent before deadline" : "no table before deadline")).ok;
  }

  if (info.owner.equals(HOLDEM_PROGRAM_ID)) {
    const t = decodeTable(ad.gameMatch, ctx.holdem.program.coder.accounts.decode("gameMatch", info.data));
    if ((t.status === STATUS.over || t.status === STATUS.cancelled) && !t.finalized) {
      return +(await act(ctx, "match", subject, `finalize (table ${t.status === STATUS.over ? "over" : "cancelled"})`, () => ctx.holdem.finalize(ctx.hsigner, id))).ok;
    }
    if (now >= deadline) return +(await refund(ctx, id, subject, "table never went live before deadline")).ok;
    log("match", subject, `${tag} wait: table on base layer (status ${t.status}), refundable ${when(deadline, now)}`);
    return 0;
  }

  if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    log("match", subject, `${tag} SKIP: table owned by ${shortKey(info.owner)}`);
    return 0;
  }

  // Delegated: the table is private to its two Players, so ask the rollup by simulation. The
  // programs enforce their own clocks; a simulation that succeeds is an action that will land.
  // (tesoro_core's 1 h refund deadline is deliberately not used while a table is live.)
  const tee = await ctx.holdem.teeConnection(ctx.hsigner);
  const timeoutIx = await ctx.holdem.program.methods
    .claimTimeout()
    .accountsPartial({ caller: ctx.payer.publicKey, gameMatch: ad.gameMatch, deck: ad.deck, hole0: ad.hole0, hole1: ad.hole1 } as any)
    .instruction();
  if (!(await simulate(tee, ctx.payer, [timeoutIx]))) {
    const r = await act(ctx, "match", subject, "claim_timeout (idle Player past deadline)", () => ctx.holdem.claimTimeout(ctx.hsigner, id));
    if (r.ok) return 1;
  }
  const closeIx = await ctx.holdem.program.methods
    .closeMatch()
    .accountsPartial({
      payer: ctx.payer.publicKey,
      gameMatch: ad.gameMatch,
      deck: ad.deck,
      hole0: ad.hole0,
      hole1: ad.hole1,
      deckPermission: permissionPdaFromAccount(ad.deck),
      hole0Permission: permissionPdaFromAccount(ad.hole0),
      hole1Permission: permissionPdaFromAccount(ad.hole1),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT,
    } as any)
    .instruction();
  if (!(await simulate(tee, ctx.payer, [closeIx]))) {
    const r = await act(ctx, "match", subject, "close_match (table finished) then finalize", async () => {
      await ctx.holdem.closeMatch(ctx.hsigner, id);
      return ctx.holdem.finalize(ctx.hsigner, id);
    });
    return +r.ok;
  }
  log("match", subject, `${tag} wait: table live in the rollup (private), no timeout due`);
  return 0;
}
