import "./polyfill";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, type ChainSigner, type Move, type Seat } from "@/games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID } from "@/games/holdem/chain";
import type { GameId } from "@/lib/mock/types";
import { getChain } from "./client";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import { EntryError, planEntry } from "./ledger";
import { fetchMatch, fetchSnapshot, findQueueMatch, type AccountSnapshot, type ChainMatch } from "./read";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The program id a Match of each Game is opened with. */
const GAME_IDS: Record<GameId, PublicKey> = { "block-puzzle": BLOCK_PUZZLE_PROGRAM_ID, holdem: HOLDEM_PROGRAM_ID };

/**
 * Match ids are chosen by the opener (ms clock, doubled). tesoro_core has no Queue/Challenge
 * concept, so the lowest bit marks a Challenge: odd ids are only joined through their link and are
 * never picked by the Queue.
 */
export function newMatchId(challenge: boolean): bigint {
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

/** SOL for fees and rent (demo faucet if needed) and the TesoroAccount itself. */
export async function ensureReady(signer: ChainSigner, getToken: GetToken): Promise<AccountSnapshot> {
  const chain = getChain();
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS);
  let snap = await fetchSnapshot(signer.publicKey);
  if (!snap.exists) {
    const ix = await chain.core.methods
      .createAccount(Array(20).fill(0))
      .accountsPartial({ authority: signer.publicKey, account: snap.accountKey, systemProgram: SystemProgram.programId })
      .instruction();
    await chain.sendBase(signer, [ix]);
    snap = await fetchSnapshot(signer.publicKey);
  }
  return snap;
}

export interface Entered {
  id: bigint;
  /** True when this Account joined a waiting Match; false when it opened a new one. */
  joined: boolean;
}

/** Queue: join the oldest open Match at this entry from another Account, else open one. */
export async function enterQueue(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle"): Promise<Entered> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  const holdings = entryHoldings(snap, entry);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = await findQueueMatch(entry, snap.accountKey, game);
    if (id === null) break;
    try {
      await chain.joinMatch(signer, id, holdings);
      return { id, joined: true };
    } catch {
      // Another Player joined first (or the Match expired): look again.
      await sleep(400);
    }
  }
  const id = newMatchId(false);
  await chain.openMatch(signer, id, entry, holdings, GAME_IDS[game]);
  return { id, joined: false };
}

/** Challenge: open a Match only reachable through its link. */
export async function createChallenge(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle"): Promise<bigint> {
  const snap = await ensureReady(signer, getToken);
  const id = newMatchId(true);
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
  await getChain().joinMatch(signer, id, entryHoldings(snap, m.entry));
}

// ---- Match orchestration --------------------------------------------------------------------

export type RunStage =
  /** Boards are not yet private-rollup ready for this Player. */
  | "needs-prep"
  /** Ready: the Player has not begun. */
  | "ready"
  /** Began but the client lost the run (reload). It can only be closed. */
  | "lost-run"
  /** This Player's run is closed. */
  | "finished"
  /** Both Boards are committed to the base layer. */
  | "committed";

const boardOwner = async (board: PublicKey) => (await getChain().base.getAccountInfo(board))?.owner ?? null;

/** Where this Player is in the on-chain flow of an Active Match. */
export async function probeRun(signer: ChainSigner, m: ChainMatch): Promise<RunStage> {
  const chain = getChain();
  if (!m.session) return "needs-prep";
  const a = BlockPuzzleChain.addresses(m.id);
  const seat = m.seat as Seat;
  const info = await chain.base.getAccountInfo(a.boards[seat]);
  if (info?.owner.equals(BLOCK_PUZZLE_PROGRAM_ID)) {
    const board: any = chain.bp.coder.accounts.decode("board", info.data);
    return board.sealed ? "committed" : "needs-prep";
  }
  if (!info?.owner.equals(DELEGATION_PROGRAM_ID)) return "needs-prep";
  const own: any = await chain.fetchOwnBoard(signer, m.id, seat).catch(() => null);
  if (!own || !own.permissionReady) return "needs-prep";
  if (own.finished || own.over) return "finished";
  if (!own.startedAt.isZero()) return "lost-run";
  return "ready";
}

/** Session, Seed, delegation and the private permission: everything before `begin_run`. Idempotent. */
export async function prepareRun(signer: ChainSigner, id: bigint, seat: Seat, onStep: (s: string) => void): Promise<void> {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const tolerate = async (fn: () => Promise<unknown>, done: () => Promise<boolean>) => {
    try {
      await fn();
    } catch (e) {
      // The other Player's client may have done this step in the same moment.
      await sleep(1500);
      if (!(await done())) throw e;
    }
  };

  const session = () => chain.bp.account.session.fetchNullable(a.session) as Promise<any>;
  if (!(await session())) {
    onStep("Starting the Match session");
    await tolerate(() => chain.startSession(signer, id), async () => !!(await session()));
  }
  if (!(await session())?.seedReady) {
    onStep("Drawing the shared Seed");
    await tolerate(() => chain.revealSeed(signer, id), async () => !!(await session())?.seedReady);
  }

  const delegated = async () =>
    (await boardOwner(a.boards[0]))?.equals(DELEGATION_PROGRAM_ID) === true && (await boardOwner(a.boards[1]))?.equals(DELEGATION_PROGRAM_ID) === true;
  if (!(await delegated())) {
    onStep("Moving both Boards to the private rollup");
    const mine = (await boardOwner(a.boards[seat]))?.equals(BLOCK_PUZZLE_PROGRAM_ID);
    if (mine) {
      await tolerate(() => chain.delegateBoards(signer, id), delegated);
    }
    for (let i = 0; i < 60 && !(await delegated()); i++) await sleep(1000);
    if (!(await delegated())) throw new Error("Boards were not delegated to the private rollup");
    await sleep(3000);
  }

  onStep("Making your Board private");
  let own: any = null;
  for (let i = 0; i < 40 && !own; i++) {
    own = await chain.fetchOwnBoard(signer, id, seat).catch(() => null);
    if (!own) await sleep(1500);
  }
  if (!own) throw new Error("Your Board is not available in the private rollup yet");
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
}

/**
 * Streams a Player's moves to their private Board: batched, in order, never blocking the game.
 * Batches are small (a few placements) so the on-chain score trails the screen by about a second.
 */
export class RunSubmitter {
  private pending: Move[] = [];
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  error: Error | null = null;
  submitted = 0;

  constructor(
    private readonly signer: ChainSigner,
    private readonly id: bigint,
    private readonly seat: Seat,
    private readonly batch = 4,
    private readonly idleMs = 1200,
  ) {}

  push(move: Move) {
    this.pending.push(move);
    if (this.timer) clearTimeout(this.timer);
    if (this.pending.length >= this.batch) this.flush();
    else this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const moves = this.pending.splice(0);
    if (!moves.length) return;
    this.queue = this.queue.then(async () => {
      if (this.error) return;
      try {
        await getChain().play(this.signer, this.id, this.seat, moves);
        this.submitted += moves.length;
      } catch (e) {
        this.error = e instanceof Error ? e : new Error(String(e));
      }
    });
  }

  /** Sends everything left, then closes the run on chain. Returns how many moves landed. */
  async finish(): Promise<number> {
    this.flush();
    await this.queue;
    await getChain().finish(this.signer, this.id, this.seat).catch(() => undefined);
    return this.submitted;
  }
}

export type SettleOutcome = "settled" | "waiting-opponent" | "failed";

/**
 * Seal + commit both Boards (only possible once both runs are closed or the deadline passed), then
 * settle through tesoro_core. Anyone may call it; a failure to seal means the opponent is still playing.
 */
export async function trySettle(signer: ChainSigner, id: bigint): Promise<{ outcome: SettleOutcome; sig?: string; error?: string }> {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const isSettled = async () => !!(await chain.bp.account.session.fetchNullable(a.session) as any)?.settled;
  if (await isSettled()) return { outcome: "settled" };
  const committed = async () =>
    (await boardOwner(a.boards[0]))?.equals(BLOCK_PUZZLE_PROGRAM_ID) === true && (await boardOwner(a.boards[1]))?.equals(BLOCK_PUZZLE_PROGRAM_ID) === true;
  if (!(await committed())) {
    try {
      await chain.sealAndCommit(signer, id);
    } catch {
      if (!(await committed())) return { outcome: "waiting-opponent" };
    }
  }
  try {
    const { sig } = await chain.settle(signer, id);
    return { outcome: "settled", sig };
  } catch (e) {
    if (await isSettled()) return { outcome: "settled" };
    return { outcome: "failed", error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/** True when the submission deadline passed and the Boards were never delegated (nothing to replay). */
export async function canClaimTimeout(m: ChainMatch): Promise<boolean> {
  if (!m.session || m.session.settled || Date.now() / 1000 <= m.session.deadline) return false;
  const a = BlockPuzzleChain.addresses(m.id);
  const owner = await boardOwner(a.boards[0]);
  return owner?.equals(BLOCK_PUZZLE_PROGRAM_ID) === true;
}

export const claimTimeout = (signer: ChainSigner, id: bigint) => getChain().claimTimeout(signer, id);

/** Opener cancels an unjoined Match (or anyone, after its refund deadline) and gets the entry back. */
export const refundMatch = (signer: ChainSigner, id: bigint) => getChain().refundMatch(signer, id);
