import "./polyfill";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, type ChainSigner, type Seat } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { sponsorPda } from "./basket";
import { getChain } from "./client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import { DrawError } from "./draw";
import { openEntry, joinEntry } from "./entry-flow";
import { readEntryStores, type BackingRef } from "./entry";
import { entryError } from "./entry-errors";
import type { StagedEntry } from "./ticket";
import { matchKeyOf } from "./match-id";
import { queueEntry, type Entered, type QueueDeps } from "./queue";
import { fetchAccountState, fetchMatch, listLiveMatchIds, listQueueMatchIds, type AccountSnapshot, type ChainMatch } from "./read";
import { plainError } from "@/lib/errors";
import { RunSubmitter } from "./run-submitter";
import { BRAND } from "../brand";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { GAME_IDS } from "./games";

/**
 * A Match is named by its opener's Account and the opener's counter: `<opener>-<n>`. The Player learns the key before
 * the transaction lands (`n` is the counter value the open will use). Challenge, Trading Duel asset and opening time
 * are fields of the Match, not bits of an id.
 */
export async function nextMatchKey(authority: PublicKey): Promise<string> {
  const account = BlockPuzzleChain.coreAccount(authority);
  const stores = await readEntryStores(account);
  return matchKeyOf({ opener: account.toBase58(), n: stores.nextMatch });
}

/** What a refused or impossible entry says to the Player (plain words). */
export const entryFailure = entryError;

export { DrawError as EntryError };

export { QueueUnconfirmedError, type Entered } from "./queue";

/**
 * `create_account`: the wallet's TesoroAccount. The wallet pays its rent unless `payer` is the relayer and `sponsored` is set,
 * in which case the sponsor repays the relayer in the same instruction (ticket 18c).
 */
export const createAccountIx = (authority: PublicKey, opts: { payer?: PublicKey; sponsored?: boolean } = {}): Promise<TransactionInstruction> =>
  getChain()
    .core.methods.createAccount(Array(20).fill(0))
    .accountsPartial({
      authority,
      account: BlockPuzzleChain.coreAccount(authority),
      basket: BlockPuzzleChain.basket(BlockPuzzleChain.coreAccount(authority)),
      spill: BlockPuzzleChain.spill(BlockPuzzleChain.coreAccount(authority)),
      systemProgram: SystemProgram.programId,
      payer: opts.payer ?? authority,
      sponsor: opts.sponsored ? sponsorPda() : null,
    })
    .instruction();

/**
 * Creates the Account on the sponsor's SOL when the wallet cannot pay its rent. True when it did; false means "carry on the
 * usual way" (the wallet has the SOL, the wallet cannot take part, or the server will not sponsor it: paused, over a limit,
 * one Account per user already given). Never throws a SponsorError.
 */
export async function createAccountSponsored(signer: ChainSigner, getToken: GetToken): Promise<boolean> {
  if (!signer.signSerialized) return false;
  if ((await getChain().base.getBalance(signer.publicKey)) >= MIN_SOL_LAMPORTS) return false;
  try {
    const { relayer, paused } = await sponsorStatus();
    if (paused) return false;
    await sponsoredSend(signer, getToken, [await createAccountIx(signer.publicKey, { payer: new PublicKey(relayer), sponsored: true })]);
    return true;
  } catch (e) {
    if (e instanceof SponsorError) return false;
    throw e;
  }
}

/** Whether the wallet has its Account, creating it on the sponsor's SOL first when it has none and no SOL (see `createAccountSponsored`). */
export async function accountReady(signer: ChainSigner, getToken: GetToken, existing: boolean): Promise<boolean> {
  return existing || (await createAccountSponsored(signer, getToken));
}

/**
 * The Account exists and its state is fresh. SOL is only needed to create the Account (the Player pays that rent);
 * entering, joining and leaving are sponsored, with the Player paying only when the relayer cannot.
 */
export async function ensureReady(signer: ChainSigner, getToken: GetToken, onStep?: (s: string) => void): Promise<AccountSnapshot> {
  onStep?.("Checking your Account…");
  // Fresh: an entry draws on the Gemas in the basket, and Gemas opened a moment ago are not in the cached lists yet.
  let snap = await fetchAccountState(signer.publicKey, { fresh: true });
  if (!snap.exists) {
    onStep?.(`Creating your ${BRAND.name} Account…`);
    if (!(await createAccountSponsored(signer, getToken))) {
      await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
      await getChain().sendBase(signer, [await createAccountIx(signer.publicKey)]);
    }
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
    newId: () => nextMatchKey(signer.publicKey),
  };
}

/** Queue: join the oldest open Match at this entry from another Account, else open one. */
export async function enterQueue(
  signer: ChainSigner,
  entry: number,
  getToken: GetToken,
  game: GameId = "block-puzzle",
  onStep?: (s: string) => void,
  asset: 0 | 1 | 2 = 0,
  backing?: BackingRef,
  /** After a definite failure: false when the entry can no longer be used (a spent Offer). */
  canRetry?: () => Promise<boolean>,
  /** Progress of a long entry prepared in steps (an Entry Ticket). */
  onStaged?: (s: StagedEntry) => void,
): Promise<Entered> {
  const snap = await ensureReady(signer, getToken);
  const common = { signer, getToken, game, entry, backing, onStep, onStaged };
  return queueEntry({
    ...queueDeps(signer, snap.accountKey, game, entry, asset),
    join: (key) => joinEntry({ ...common, key }),
    open: () => openEntry({ ...common, challenge: false, asset: game === "trading-duel" ? asset : 0 }),
    canRetry,
    onStep,
  });
}

/** Challenge: open a Match only reachable through its link. Resolves with the Match key. */
export async function createChallenge(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle", asset: 0 | 1 | 2 = 0, onStep?: (s: string) => void, backing?: BackingRef, onStaged?: (s: StagedEntry) => void): Promise<string> {
  await ensureReady(signer, getToken, onStep);
  onStep?.("Opening your Challenge…");
  return (await openEntry({ signer, getToken, game, entry, backing, onStep, onStaged, challenge: true, asset: game === "trading-duel" ? asset : 0 })).key;
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
export async function joinChallenge(signer: ChainSigner, key: string, getToken: GetToken, backing?: BackingRef, onStaged?: (s: StagedEntry) => void): Promise<void> {
  const snap = await ensureReady(signer, getToken);
  const m = await fetchMatch(key, snap.accountKey);
  if (!m) throw new ChallengeError("missing");
  if (!m.challenge) throw new ChallengeError("not-challenge");
  if (m.seat !== null) return;
  if (m.status !== "open") throw new ChallengeError("taken");
  await joinEntry({ signer, getToken, game: m.game, entry: m.entry, backing, key, onStaged });
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
export async function prepareRun(signer: ChainSigner, id: string, seat: Seat, onStep: (s: string) => void): Promise<void> {
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
export function runSubmitter(signer: ChainSigner, id: string, seat: Seat): RunSubmitter {
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
async function bringForfeitedBoardsIn(signer: ChainSigner, id: string, session: NonNullable<ChainMatch["session"]>) {
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
  id: string,
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

export const claimTimeout = (signer: ChainSigner, id: string) => getChain().claimTimeout(signer, id);

/** Opener cancels an unjoined Match (or anyone, after its refund deadline) and gets the entry back. */
export const refundMatch = (signer: ChainSigner, id: string) => getChain().refundMatch(signer, id);
