import "./polyfill";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, type ChainSigner, type Seat } from "@/games/block-puzzle/chain";
import { duelMatchId } from "@/games/trading-duel/chain";
import type { GameId } from "@/lib/mock/types";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import { EntryError, planEntry } from "./ledger";
import { queueEntry, type Entered, type QueueDeps } from "./queue";
import { fetchAccountState, fetchMatch, listLiveMatchIds, listQueueMatchIds, type AccountSnapshot, type ChainMatch } from "./read";
import { plainError } from "@/lib/errors";
import { RunSubmitter } from "./run-submitter";
import { BRAND } from "../brand";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { GAME_IDS } from "./games";
import { GAME_IDS } from "./games";

/**
 * Match ids are chosen by the opener (ms clock, doubled). tesoro_core has no Queue/Challenge
 * concept, so the lowest bit marks a Challenge: odd ids are only joined through their link and are
 * never picked by the Queue. Trading Duel ids are `ms * 8 + asset * 2 + challenge`: bits 1 and 2 carry
 * the asset the Match trades, so the Queue is per asset and nobody can change it later.
 */
export function newMatchId(challenge: boolean, game: GameId = "block-puzzle", asset: 0 | 1 | 2 = 0): bigint {
  if (game === "trading-duel") return duelMatchId(asset, challenge);
  return BigInt(Date.now()) * 2n + (challenge ? 1n : 0n);
}

export const isChallengeId = (id: bigint) => (id & 1n) === 1n;

/** Holdings an entry of `entry` Gemas draws on, in tesoro_core's canonical order. */
export function entryHoldings(snapshot: AccountSnapshot, entry: number): PublicKey[] {
  const idx = planEntry(
    BigInt(entry),
    snapshot.holdings.map((h) => ({ source: h.source.toBytes(), isOwn: h.isOwn, free: h.free })),
  );
  return idx.map((i) => snapshot.holdings[i].holding);
}

export { EntryError };
export { QueueUnconfirmedError, type Entered } from "./queue";

/** `create_account`: the wallet's TesoroAccount. */
export const createAccountIx = (authority: PublicKey): Promise<TransactionInstruction> =>
  getChain()
    .core.methods.createAccount(Array(20).fill(0))
    .accountsPartial({ authority, account: BlockPuzzleChain.coreAccount(authority), systemProgram: SystemProgram.programId })
    .instruction();

/** SOL for fees and rent (demo faucet if needed) and the TesoroAccount itself. */
export async function ensureReady(signer: ChainSigner, getToken: GetToken, onStep?: (s: string) => void): Promise<AccountSnapshot> {
  onStep?.("Checking your SOL and Account…");
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  // Fresh: an entry draws on these Holdings, and Gemas opened a moment ago are not in the cached lists yet.
  let snap = await fetchAccountState(signer.publicKey, { fresh: true });
  if (!snap.exists) {
    onStep?.(`Creating your ${BRAND.name} Account…`);
    await getChain().sendBase(signer, [await createAccountIx(signer.publicKey)]);
    snap = await fetchAccountState(signer.publicKey, { fresh: true });
  }
  return snap;
}

/**
 * Matches of this Game the Player still has to play: a Hold'em table that is not over, or a Block
 * Puzzle run not begun while it still can be. Fresh account reads; an unreadable run counts.
 */
export async function unfinishedMatches(signer: ChainSigner, me: PublicKey, game: GameId): Promise<ChainMatch[]> {
  const now = Date.now() / 1000;
  const out: ChainMatch[] = [];
  for (const id of await listLiveMatchIds(me, game)) {
    const m = await fetchMatch(id, me);
    if (!m || m.seat === null || (m.status !== "open" && m.status !== "active") || now > m.deadline) continue;
    if (m.game === "block-puzzle") {
      if (!m.session || m.session.settled) continue;
      const beginBy = m.seat === 0 ? m.session.openerDeadline : m.session.joined ? m.session.deadline : m.deadline;
      if (now > beginBy) continue;
      const stage = await probeRun(signer, m, false).catch((): RunStage => "needs-prep");
      if (stage !== "needs-prep" && stage !== "ready") continue;
    }
    out.push(m);
  }
  return out;
}

/** The parts of a Queue entry that do not depend on how the entry is funded. */
export function queueDeps(signer: ChainSigner, me: PublicKey, game: GameId, entry: number, asset: 0 | 1 | 2 = 0): Omit<QueueDeps, "join" | "open"> {
  const chain = getChain();
  return {
    game,
    entry,
    asset: game === "trading-duel" ? asset : undefined,
    listCandidates: () => listQueueMatchIds(entry, me, game, game === "trading-duel" ? asset : undefined),
    readMatch: (id) => fetchMatch(id, me),
    settle: (e) => chain.txOutcome(e),
    unfinished: () => unfinishedMatches(signer, me, game),
    newId: () => newMatchId(false, game, asset),
  };
}

/** Queue: join the oldest open Match at this entry from another Account, else open one. */
export async function enterQueue(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle", onStep?: (s: string) => void, asset: 0 | 1 | 2 = 0): Promise<Entered> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  const holdings = entryHoldings(snap, entry);
  return queueEntry({
    ...queueDeps(signer, snap.accountKey, game, entry, asset),
    join: (id) => chain.joinMatch(signer, id, holdings, GAME_IDS[game]),
    open: (id) => chain.openMatch(signer, id, entry, holdings, GAME_IDS[game]),
    onStep,
  });
}

/** Challenge: open a Match only reachable through its link. */
export async function createChallenge(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle", asset: 0 | 1 | 2 = 0, onStep?: (s: string) => void): Promise<bigint> {
  const snap = await ensureReady(signer, getToken, onStep);
  const id = newMatchId(true, game, asset);
  onStep?.("Opening your Challenge…");
  await getChain().openMatch(signer, id, entry, entryHoldings(snap, entry), GAME_IDS[game]);
  return id;
}

export class ChallengeError extends Error {
  constructor(readonly code: "missing" | "own" | "taken" | "not-challenge") {
    super(
      {
        missing: "This Challenge does not exist.",
        own: "This is your own Challenge. Send the link to your opponent.",
        taken: "Someone already joined this Challenge.",
        "not-challenge": "This link is not a Challenge.",
      }[code],
    );
  }
}

/** Opening a Challenge link joins it. Already-joined participants just continue to the Match. */
export async function joinChallenge(signer: ChainSigner, id: bigint, getToken: GetToken): Promise<void> {
  const snap = await ensureReady(signer, getToken);
  const m = await fetchMatch(id, snap.accountKey);
  if (!m) throw new ChallengeError("missing");
  if (!m.challenge) throw new ChallengeError("not-challenge");
  if (m.seat !== null) return;
  if (m.status !== "open") throw new ChallengeError("taken");
  await getChain().joinMatch(signer, id, entryHoldings(snap, m.entry), GAME_IDS[m.game]);
}

// ---- Match orchestration --------------------------------------------------------------------

/**
 * A Match joined on `tesoro_core` without a session join (an older client, or a join whose second
 * step was lost) is bound by anyone before its 1 h refund deadline. Idempotent.
 */
export async function ensureJoined(signer: ChainSigner, m: ChainMatch): Promise<void> {
  if (m.game !== "block-puzzle" || !m.session || m.session.joined || m.status !== "active" || m.seat === null || !m.opponent) return;
  const chain = getChain();
  const accountB = m.seat === 1 ? BlockPuzzleChain.coreAccount(signer.publicKey) : new PublicKey(m.opponent);
  await chain.sendBase(signer, [await chain.joinSessionIx(signer.publicKey, m.id, accountB)]).catch(() => undefined);
}

export type RunStage =
  /** Not yet private-rollup ready for this Player (session, delegation, permission or Seed pending). */
  | "needs-prep"
  /** Ready: the Player has not begun and the Seed is drawn. */
  | "ready"
  /** Began but the client lost the run (reload). It can only be closed. */
  | "lost-run"
  /** This Player's run is closed. */
  | "finished"
  /** Both Boards are committed to the base layer. */
  | "committed";

const boardOwner = async (board: PublicKey) => (await getChain().base.getAccountInfo(board))?.owner ?? null;
const isDelegated = async (k: PublicKey) => (await boardOwner(k))?.equals(DELEGATION_PROGRAM_ID) === true;
const isProgramOwned = async (k: PublicKey) => (await boardOwner(k))?.equals(BLOCK_PUZZLE_PROGRAM_ID) === true;

/**
 * Where this Player is in the on-chain flow. Works for an Open Match too: the opener plays before
 * anyone is paired. `verifySeed` also pings the rollup to check the Seed is drawn (a tiny
 * transaction), so "ready" is only reported when Start will work.
 */
/** `quiet`: never ask the wallet to sign; a delegated Board without a rollup session already open throws instead. */
export async function probeRun(signer: ChainSigner, m: ChainMatch, verifySeed = true, quiet = false): Promise<RunStage> {
  const chain = getChain();
  if (!m.session || m.seat === null) return "needs-prep";
  const a = BlockPuzzleChain.addresses(m.id);
  const seat = m.seat as Seat;
  const info = await chain.base.getAccountInfo(a.boards[seat]);
  if (info?.owner.equals(BLOCK_PUZZLE_PROGRAM_ID)) {
    const board: any = chain.bp.coder.accounts.decode("board", info.data);
    return board.sealed ? "committed" : "needs-prep";
  }
  if (!info?.owner.equals(DELEGATION_PROGRAM_ID)) return "needs-prep";
  if (quiet && !chain.hasTeeSession(signer)) throw new Error("No rollup session yet.");
  const own: any = await chain.fetchOwnBoard(signer, m.id, seat).catch(() => null);
  if (!own || !own.permissionReady) return "needs-prep";
  if (own.finished || own.over) return "finished";
  if (!own.startedAt.isZero()) return "lost-run";
  if (verifySeed && !(await chain.seedReady(signer, m.id))) return "needs-prep";
  return "ready";
}

/**
 * Everything before `begin_run`: the Session, delegation, the private permissions and the hidden
 * Seed (VRF inside the rollup). Idempotent; the other Player's client (or a keeper) may do the same
 * steps in the same moment.
 */
export async function prepareRun(signer: ChainSigner, id: bigint, seat: Seat, onStep: (s: string) => void): Promise<void> {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const tolerate = async (fn: () => Promise<unknown>, done: () => Promise<boolean>) => {
    try {
      await fn();
    } catch (e) {
      await sleep(1500);
      if (!(await done())) throw e;
    }
  };
  const session = () => chain.bp.account.session.fetchNullable(a.session) as Promise<any>;

  if (!(await session())) throw new Error(`This Match was opened by an older version of ${BRAND.name} and can’t be played here.`);
  if (seat === 1 && !(await session()).joined) {
    onStep("Joining the Match");
    await tolerate(
      async () => chain.sendBase(signer, [await chain.joinSessionIx(signer.publicKey, id, BlockPuzzleChain.coreAccount(signer.publicKey))]),
      async () => !!(await session())?.joined,
    );
  }

  if (!(await isDelegated(a.boards[0])) || !(await isDelegated(a.vault))) {
    onStep("Creating your session");
    if (await isProgramOwned(a.boards[0])) await tolerate(() => chain.delegateOpener(signer, id), async () => await isDelegated(a.boards[0]));
    for (let i = 0; i < 60 && !(await isDelegated(a.boards[0])); i++) await sleep(1000);
  }
  if (seat === 1 && !(await isDelegated(a.boards[1]))) {
    onStep("Creating your session");
    if (await isProgramOwned(a.boards[1])) await tolerate(() => chain.delegateJoiner(signer, id), async () => await isDelegated(a.boards[1]));
    for (let i = 0; i < 60 && !(await isDelegated(a.boards[1])); i++) await sleep(1000);
  }
  if (!(await isDelegated(a.boards[seat]))) throw new Error("Couldn’t create your session. Try again.");
  await sleep(2500);

  onStep("Securing your session");
  let own: any = null;
  for (let i = 0; i < 40 && !own; i++) {
    own = await chain.fetchOwnBoard(signer, id, seat).catch(() => null);
    if (!own) await sleep(1500);
  }
  if (!own) throw new Error("Your session isn’t ready yet. Try again in a moment.");
  if (!own.permissionReady) {
    for (let i = 0; i < 4; i++) {
      try {
        await chain.initPermission(signer, id, seat);
        break;
      } catch (e) {
        await sleep(2000);
        const again: any = await chain.fetchOwnBoard(signer, id, seat).catch(() => null);
        if (again?.permissionReady) break;
        if (i === 3) throw e;
      }
    }
  }

  if (!(await chain.seedReady(signer, id))) {
    onStep("Dealing your pieces");
    await tolerate(() => chain.initVaultPermission(signer, id), async () => true);
    for (let i = 0; i < 30; i++) {
      if (i % 10 === 0) await chain.requestSeed(signer, id, 7 + (i % 200)).catch(() => undefined);
      await sleep(1500);
      if (await chain.seedReady(signer, id)) return;
    }
    throw new Error("Dealing your pieces took too long. Try again.");
  }
}

/** The Player's move stream for one Match, wired to the chain (see run-submitter.ts). */
export function runSubmitter(signer: ChainSigner, id: bigint, seat: Seat): RunSubmitter {
  const chain = getChain();
  return new RunSubmitter({
    play: (moves) => chain.play(signer, id, seat, moves),
    finish: () => chain.finish(signer, id, seat),
    movesOnChain: async () => {
      const board: any = await chain.fetchOwnBoard(signer, id, seat);
      return board ? Number(board.moves) : null;
    },
  });
}

export type SettleOutcome = "settled" | "waiting-opponent" | "commit-pending" | "failed";

/**
 * Once the deadline of a Board's Player has passed, anyone may put an unplayed Board in the rollup
 * and give it its permission so it can be sealed (its Player forfeits). No-op before that.
 */
async function bringForfeitedBoardsIn(signer: ChainSigner, id: bigint, session: NonNullable<ChainMatch["session"]>) {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const now = Date.now() / 1000;
  const due: Seat[] = [];
  if (now > session.openerDeadline) due.push(0);
  if (session.joined && now > session.deadline) due.push(1);
  for (const seat of due) {
    if (await isProgramOwned(a.boards[seat])) {
      if (seat === 0) await chain.delegateOpener(signer, id).catch(() => undefined);
      else await chain.delegateJoiner(signer, id).catch(() => undefined);
    }
    const conn = await chain.tee(signer);
    const info = await conn.getAccountInfo(a.boards[seat]).catch(() => null);
    if (info) {
      const board: any = chain.bp.coder.accounts.decode("board", info.data);
      if (!board.permissionReady) await chain.initPermission(signer, id, seat).catch(() => undefined);
    }
  }
}

/**
 * Seal + commit both Boards (only possible once both runs are closed or their deadlines passed), then
 * settle through tesoro_core. Anyone may call it; a failure to seal means the opponent is still playing.
 */
export async function trySettle(
  signer: ChainSigner,
  id: bigint,
  session?: ChainMatch["session"],
  opts: { sealed?: boolean; onSent?: () => void } = {},
): Promise<{ outcome: SettleOutcome; sig?: string; error?: string }> {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const isSettled = async () => !!(await chain.bp.account.session.fetchNullable(a.session) as any)?.settled;
  if (await isSettled()) return { outcome: "settled" };
  const committed = async () => (await isProgramOwned(a.boards[0])) && (await isProgramOwned(a.boards[1]));
  if (!(await committed())) {
    // Seal + commit already went through: do not resend, the rollup has to hand the Boards back.
    if (opts.sealed) return { outcome: "commit-pending" };
    let sent = false;
    try {
      if (session) await bringForfeitedBoardsIn(signer, id, session);
      await chain.sealAndCommit(signer, id, () => {
        sent = true;
        opts.onSent?.();
      });
    } catch {
      if (!(await committed())) return { outcome: sent ? "commit-pending" : "waiting-opponent" };
    }
  }
  try {
    const { sig } = await chain.settle(signer, id);
    return { outcome: "settled", sig };
  } catch (e) {
    if (await isSettled()) return { outcome: "settled" };
    return { outcome: "failed", error: plainError(e) };
  }
}

/** True when the joiner's deadline passed and neither Board was ever delegated (nothing to replay). */
export async function canClaimTimeout(m: ChainMatch): Promise<boolean> {
  if (!m.session || !m.session.joined || m.session.settled || Date.now() / 1000 <= m.session.deadline) return false;
  const a = BlockPuzzleChain.addresses(m.id);
  return (await isProgramOwned(a.boards[0])) && (await isProgramOwned(a.boards[1]));
}

export const claimTimeout = (signer: ChainSigner, id: bigint) => getChain().claimTimeout(signer, id);

/** Opener cancels an unjoined Match (or anyone, after its refund deadline) and gets the entry back. */
export const refundMatch = (signer: ChainSigner, id: bigint) => getChain().refundMatch(signer, id);
