import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, type Seat } from "../../app/src/games/block-puzzle/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { refundMatchIx } from "./core-ix.ts";
import { keyOf, matchAddress, matchRefOf } from "./kit.ts";
import { sendIxs } from "./send.ts";
import { simulate, when } from "./tee.ts";

/** Rollup attempts per Match are spaced out: a refused seal is free but not worth a request every pass. */
const RETRY_MS = 60_000;
const nextTry = new Map<string, number>();
const throttled = (key: string) => (nextTry.get(key) ?? 0) > Date.now();
const backoff = (key: string) => nextTry.set(key, Date.now() + RETRY_MS);

/** Starts a refund of a Match whose deadline passed (core lets anyone); the settle job then runs its chunks. `m` is the decoded `MatchState.inner`. */
export const refund = (ctx: Ctx, m: any, subject: string, why: string) =>
  act(ctx, "match", subject, `refund_match (${why})`, async () => {
    const ix = await refundMatchIx(ctx.core, { caller: ctx.payer.publicKey, payer: ctx.payer.publicKey, game: keyOf(m.game), matchState: matchAddress(matchRefOf(m.id)) });
    return sendIxs(ctx.conn, ctx.payer, [ix], { units: 300_000 });
  });

const decodeSession = (ctx: Ctx, info: AccountInfo<Buffer> | null): any | null => {
  if (!info || !info.owner.equals(BLOCK_PUZZLE_PROGRAM_ID)) return null;
  try {
    return ctx.bp.bp.coder.accounts.decode("session", info.data);
  } catch {
    return null;
  }
};
const decodeBoard = (ctx: Ctx, info: AccountInfo<Buffer> | null): any | null => {
  if (!info || !info.owner.equals(BLOCK_PUZZLE_PROGRAM_ID)) return null;
  try {
    return ctx.bp.bp.coder.accounts.decode("board", info.data);
  } catch {
    return null;
  }
};

/**
 * An Open Match is refunded only once its on-chain deadline has passed. The deadline is read from
 * the Match, so it follows the Queue window `open_session` set (24 h) and an older Match's 1 h.
 */
export function openQueueStep(now: number, deadline: number): "wait" | "refund" {
  return now < deadline ? "wait" : "refund";
}

/**
 * Block Puzzle hygiene for one unsettled tesoro_core Match (open_session / join_session flow).
 *
 * Open Match: nobody joined. The opener's Board and SeedVault live in the TEE; nothing to do there
 * (the rollup cannot see the base Match, so they stay delegated, a few thousand lamports). After the
 * Queue window (24 h, set at open_session) anyone refunds the entry.
 *
 * Active Match: joined on tesoro_core. A joiner who skipped `join_session` is bound (anyone can).
 * Then, per Board:
 *   - neither delegated: nobody played. `claim_timeout` once the joiner's deadline passed.
 *   - a Board still on the base layer (its Player never delegated) once its deadline passed: delegate
 *     it and create its permission, so `seal` can run (that Player forfeits).
 *   - both in the rollup: `seal` (program-enforced: both runs closed or deadlines passed) + `commit_boards`,
 *     then `settle` on the base layer. A free simulation of `seal` decides; otherwise the keeper waits.
 *   - both committed and sealed: `settle`.
 * Returns the number of actions taken.
 */
export async function blockPuzzle(ctx: Ctx, id: string, m: any, st: string, subject: string): Promise<number> {
  const now = ctx.now;
  const deadline = Number(m.deadline.toString());
  const tag = `[block-puzzle ${st}${m.meta?.challenge ? " challenge" : ""}]`;

  if (st === "open") {
    if (openQueueStep(now, deadline) === "wait") {
      log("match", subject, `${tag} wait: nobody joined, Queue window ends ${when(deadline, now)} (then refund_match)`);
      return 0;
    }
    return +(await refund(ctx, m, subject, "Queue window over, nobody joined")).ok;
  }

  const a = BlockPuzzleChain.addresses(id);
  const [sInfo, b0Info, b1Info] = await ctx.conn.getMultipleAccountsInfo([a.session, ...a.boards]);
  const session = decodeSession(ctx, sInfo);
  if (!session) {
    const why = sInfo ? "Session in an older layout (pre open_session/join_session build), this program cannot settle it" : "no Session";
    if (now < deadline) {
      log("match", subject, `${tag} wait: ${why}; refundable ${when(deadline, now)}`);
      return 0;
    }
    return +(await refund(ctx, m, subject, why)).ok;
  }
  if (session.settled) {
    log("match", subject, `${tag} Session settled but Match still active: nothing to do`);
    return 0;
  }

  if (!session.joined) {
    // Joined on tesoro_core without join_session (an older client). Binding is permissionless and only
    // possible inside the Match's 1 h window.
    if (now >= deadline) return +(await refund(ctx, m, subject, "joined without a Session and past the window")).ok;
    const r = await act(ctx, "match", subject, "join_session (bind a Match joined without it)", async () => {
      const ix = await ctx.bp.joinSessionIx(ctx.payer.publicKey, id, new PublicKey(Uint8Array.from(m.b.player)));
      return ctx.bp.sendBase(ctx.signer, [ix]);
    });
    return +r.ok;
  }

  const openerDeadline = Number(session.openerDeadline.toString());
  const joinerDeadline = Number(session.deadline.toString());
  const boardDeadlines = [openerDeadline, joinerDeadline];
  const delegated = [b0Info, b1Info].map((i) => !!i?.owner.equals(DELEGATION_PROGRAM_ID));

  if (!delegated[0] && !delegated[1]) {
    const boards = [decodeBoard(ctx, b0Info), decodeBoard(ctx, b1Info)];
    if (boards.every((b) => b?.sealed)) {
      return +(await act(ctx, "match", subject, "settle (both Boards committed and sealed)", async () => (await ctx.bp.settle(ctx.signer, id)).sig)).ok;
    }
    if (now < joinerDeadline) {
      log("match", subject, `${tag} wait: no Board delegated, nobody has played; Players forfeit ${when(joinerDeadline, now)} (then claim_timeout)`);
      return 0;
    }
    if (boards.every((b) => b && !b.sealed && b.startedAt.isZero())) {
      return +(await act(ctx, "match", subject, "claim_timeout (deadline passed, nobody played)", () => ctx.bp.claimTimeout(ctx.signer, id))).ok;
    }
    log("match", subject, `${tag} SKIP: past deadline, Boards on the base layer are neither sealed nor unplayed (needs a look)`);
    return 0;
  }

  // At least one Board is in the rollup: seal needs both there.
  let actions = 0;
  for (const seat of [0, 1] as Seat[]) {
    if (delegated[seat]) continue;
    if (now < boardDeadlines[seat]) {
      log("match", subject, `${tag} wait: seat ${seat} Board never delegated; that Player forfeits ${when(boardDeadlines[seat], now)}, only then can seal run`);
      return actions;
    }
    const r = await act(ctx, "match", subject, `delegate seat ${seat} Board into the rollup (that Player forfeited)`, () =>
      seat === 0 ? ctx.bp.delegateOpener(ctx.signer, id) : ctx.bp.delegateJoiner(ctx.signer, id),
    );
    if (!r.ok) return actions;
    actions++;
  }

  const key = `seal:${id}`;
  const pastAll = now >= Math.max(openerDeadline, joinerDeadline);
  let reason = "both deadlines passed";
  if (!pastAll) {
    if (throttled(key)) {
      log("match", subject, `${tag} wait: runs still open (checked <${RETRY_MS / 1000}s ago); deadlines ${when(openerDeadline, now)} / ${when(joinerDeadline, now)}`);
      return actions;
    }
    const tee = await ctx.bp.tee(ctx.signer);
    const seal = await ctx.bp.bp.methods
      .seal()
      .accountsPartial({ payer: ctx.payer.publicKey, board0: a.boards[0], board1: a.boards[1] })
      .instruction();
    const err = await simulate(tee, ctx.payer, [seal]);
    if (err) {
      backoff(key);
      log("match", subject, `${tag} wait: both Boards in the rollup, seal refused (${err.slice(0, 120)}); deadlines ${when(openerDeadline, now)} / ${when(joinerDeadline, now)}`);
      return actions;
    }
    reason = "both runs closed";
  }
  // commit_boards closes all three permissions in the same transaction as seal, so a missing one fails both.
  const perms = await ensurePermissions(ctx, id, subject);
  actions += perms.sent;
  if (!perms.ready) {
    backoff(key);
    return actions;
  }
  const sealed = await act(ctx, "match", subject, `seal + commit_boards (${reason})`, async () => (await ctx.bp.sealAndCommit(ctx.signer, id)).teeSig);
  if (!sealed.ok) {
    backoff(key);
    return actions;
  }
  const settled = await act(ctx, "match", subject, "settle (after commit)", async () => (await ctx.bp.settle(ctx.signer, id)).sig);
  return actions + 1 + +settled.ok;
}

/**
 * Creates whichever of the two Board permissions and the SeedVault permission is missing in the rollup. Each is its own
 * step, retried on every pass until it exists: delegation and permission used to share one action, so a permission that
 * failed after a successful delegate was never retried. `init_permission` / `init_vault_permission` accept an existing
 * real permission, so a repeat is harmless.
 */
export async function ensurePermissions(ctx: Ctx, id: string, subject: string): Promise<{ ready: boolean; sent: number }> {
  const a = BlockPuzzleChain.addresses(id);
  const tee = await ctx.bp.tee(ctx.signer);
  const targets = [a.boards[0], a.boards[1], a.vault];
  const infos = await tee.getMultipleAccountsInfo(targets.map((t) => permissionPdaFromAccount(t)));
  let ready = true;
  let sent = 0;
  for (let i = 0; i < targets.length; i++) {
    if (infos[i]?.owner.equals(PERMISSION_PROGRAM_ID)) continue;
    const what = i < 2 ? `init_permission seat ${i} (missing)` : "init_vault_permission (missing)";
    const r = await act(ctx, "match", subject, what, () => (i < 2 ? ctx.bp.initPermission(ctx.signer, id, i as Seat) : ctx.bp.initVaultPermission(ctx.signer, id)));
    if (r.ok) sent++;
    else ready = false;
  }
  return { ready, sent };
}
