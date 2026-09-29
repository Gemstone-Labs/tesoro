import { PublicKey, Transaction, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { HOLDEM_PROGRAM_ID, STATUS, addresses as holdemAddresses, decodeTable } from "../../app/src/games/holdem/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";

const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const status = (o: object) => Object.keys(o)[0];
const when = (deadline: number, now: number) => (deadline > now ? `in ${deadline - now}s` : `${now - deadline}s ago`);

/** Free dry-run of a rollup transaction; null when it would succeed, else the error text. */
async function simulate(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string | null> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  try {
    const res = await conn.simulateTransaction(tx);
    return res.value.err ? JSON.stringify(res.value.err) : null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

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

const refund = (ctx: Ctx, id: bigint, subject: string, why: string) =>
  act(ctx, "match", subject, `refund_match (${why})`, () => ctx.bp.refundMatch(ctx.signer, id));

async function blockPuzzle(ctx: Ctx, id: bigint, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[block-puzzle ${st.toLowerCase()}${(id & 1n) === 1n ? " challenge" : ""}]`;
  if (st === "open") {
    if (now < deadline) {
      log("match", subject, `${tag} wait: nobody joined yet, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, "no opponent before deadline")).ok;
  }

  const a = BlockPuzzleChain.addresses(id);
  const session: any = await ctx.bp.bp.account.session.fetchNullable(a.session);
  if (!session) {
    if (now < deadline) {
      log("match", subject, `${tag} wait: joined but no session started, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, "no session before deadline")).ok;
  }
  if (session.settled) {
    log("match", subject, `${tag} session settled but Match still active: nothing to do`);
    return 0;
  }
  const sessionDeadline = Number(session.deadline.toString());
  if (!session.seedReady) {
    if (now < deadline) {
      log("match", subject, `${tag} wait: Seed not revealed, refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, id, subject, "Seed never revealed")).ok;
  }

  const infos = await ctx.conn.getMultipleAccountsInfo(a.boards);
  const delegated = infos.some((i) => i?.owner.equals(DELEGATION_PROGRAM_ID));
  if (!delegated) {
    const boards: any[] = infos.map((i) => (i ? ctx.bp.bp.coder.accounts.decode("board", i.data) : null));
    if (boards.every((b) => b?.sealed)) {
      const r = await act(ctx, "match", subject, "settle (both runs sealed)", async () => (await ctx.bp.settle(ctx.signer, id)).sig);
      return +r.ok;
    }
    if (now < sessionDeadline) {
      log("match", subject, `${tag} wait: Boards not delegated, submission deadline ${when(sessionDeadline, now)}`);
      return 0;
    }
    const neverStarted = boards.every((b) => b && !b.sealed && b.startedAt.isZero());
    if (neverStarted) return +(await act(ctx, "match", subject, "claim_timeout (submission deadline passed, nobody played)", () => ctx.bp.claimTimeout(ctx.signer, id))).ok;
    log("match", subject, `${tag} SKIP: past deadline but Boards are neither sealed nor unplayed (needs a look)`);
    return 0;
  }

  // Boards are in the private rollup: their contents are unreadable here, but seal is permissionless
  // and refuses unless both runs are closed or the deadline passed, so a free simulation decides.
  const pastDeadline = now >= sessionDeadline;
  let reason = pastDeadline ? "submission deadline passed" : "";
  if (!pastDeadline) {
    const tee = await ctx.bp.tee(ctx.signer);
    const seal = await ctx.bp.bp.methods
      .seal()
      .accountsPartial({ payer: ctx.payer.publicKey, board0: a.boards[0], board1: a.boards[1] })
      .instruction();
    const err = await simulate(tee, ctx.payer, [seal]);
    if (err) {
      log("match", subject, `${tag} wait: Boards delegated, runs still open, deadline ${when(sessionDeadline, now)}`);
      return 0;
    }
    reason = "both runs closed";
  }
  const sealed = await act(ctx, "match", subject, `seal + commit_boards (${reason})`, async () => (await ctx.bp.sealAndCommit(ctx.signer, id)).teeSig);
  if (!sealed.ok) return 0;
  const settled = await act(ctx, "match", subject, "settle (after commit)", async () => (await ctx.bp.settle(ctx.signer, id)).sig);
  return 1 + +settled.ok;
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
