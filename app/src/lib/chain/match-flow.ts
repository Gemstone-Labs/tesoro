import "./polyfill";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { sponsorPda } from "./basket";
import { getChain } from "./client";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";
import { sendSponsoredOrOwn } from "./sponsored-or-own";
import { MIN_SOL_LAMPORTS } from "./config";
import { ensureSol, type GetToken } from "./demo-client";
import { DrawError } from "./draw";
import { openEntry, joinEntry } from "./entry-flow";
import { readEntryStores, type BackingRef } from "./entry";
import { entryError } from "./entry-errors";
import type { StagedEntry } from "./ticket";
import { matchKeyOf } from "./match-id";
import { mergeQueue, queueEntry, type Entered, type Merged, type QueueDeps } from "./queue";
import { fetchAccountState, fetchMatch, listLiveMatchIds, listQueueMatchIds, type AccountSnapshot, type ChainMatch } from "./read";
import { filterByLease, freshLeases } from "./presence";
import { BRAND } from "../brand";

/**
 * What the Match records as `meta.asset`: the Trading Duel asset, and for Hold'em the speed (1, turbo: the 5-level sit-and-go
 * every Hold'em Match plays). Other Games ignore it.
 */
export const matchAsset = (game: string, asset: number): number => (game === "trading-duel" ? asset : game === "holdem" ? 1 : 0);

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

/** Matches of this Game the Player is still in: Open or Active and not past their refund deadline. Fresh account reads. */
export async function unfinishedMatches(me: PublicKey, game: GameId): Promise<ChainMatch[]> {
  const now = Date.now() / 1000;
  const out: ChainMatch[] = [];
  for (const id of await listLiveMatchIds(me, game)) {
    const m = await fetchMatch(id, me);
    if (!m || m.seat === null || (m.status !== "open" && m.status !== "active") || now > m.deadline) continue;
    out.push(m);
  }
  return out;
}

/** The parts of a Queue entry that do not depend on how the entry is funded. */
/** `funder`: who pays the entry (a Backer's Account, or `me`): seats tesoro_core would refuse to the pair are skipped. */
export function queueDeps(signer: ChainSigner, me: PublicKey, game: GameId, entry: number, asset: 0 | 1 | 2 = 0, funder: PublicKey = me): Omit<QueueDeps, "join" | "open"> {
  const chain = getChain();
  return {
    game,
    entry,
    asset: game === "trading-duel" ? asset : undefined,
    entrant: { player: me.toBase58(), funder: funder.toBase58() },
    listCandidates: async () => {
      const ids = await listQueueMatchIds(entry, me, game, game === "trading-duel" ? asset : undefined, funder);
      // Block Burst: a Match whose opener left the Queue page would be a seat nobody sits in (Challenges are not in this list).
      return game === "block-puzzle" ? filterByLease(ids, await freshLeases(ids)) : ids;
    },
    readMatch: (id) => fetchMatch(id, me),
    settle: (e) => chain.txOutcome(e),
    unfinished: () => unfinishedMatches(me, game),
    newId: () => nextMatchKey(signer.publicKey),
  };
}

/** The Queue entry for one Account: how it joins, opens and (for the merge) refunds. Never backed. */
function plainQueueDeps(signer: ChainSigner, me: PublicKey, getToken: GetToken, game: GameId, entry: number, asset: 0 | 1 | 2, onStep?: (s: string) => void): QueueDeps & { refund(id: string): Promise<unknown> } {
  const common = { signer, getToken, game, entry, onStep };
  return {
    ...queueDeps(signer, me, game, entry, asset, me),
    join: (key) => joinEntry({ ...common, key }),
    open: () => openEntry({ ...common, challenge: false, asset: matchAsset(game, asset) }),
    refund: (id) => refundMatch(signer, id, getToken),
    onStep,
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
    ...queueDeps(signer, snap.accountKey, game, entry, asset, backing?.backerAccount ?? snap.accountKey),
    join: (key) => joinEntry({ ...common, key }),
    open: () => openEntry({ ...common, challenge: false, asset: matchAsset(game, asset) }),
    canRetry,
    onStep,
  });
}

/**
 * The Player's own waiting Queue Match, if an older open Match at the same entry has appeared: refunds this one and joins the
 * older (see `mergeQueue`). `{ moved: false }` leaves everything as it was. Throws only when a send's fate is unknown.
 */
export async function mergeIntoOlderMatch(signer: ChainSigner, getToken: GetToken, mine: ChainMatch, on: { onMove?(): void; onStep?(s: string): void } = {}): Promise<Merged> {
  const snap = await fetchAccountState(signer.publicKey, { fresh: true });
  return mergeQueue({ ...plainQueueDeps(signer, snap.accountKey, getToken, mine.game, mine.entry, mine.asset as 0 | 1 | 2, on.onStep), onMove: on.onMove }, mine);
}

/** Challenge: open a Match only reachable through its link. Resolves with the Match key. */
export async function createChallenge(signer: ChainSigner, entry: number, getToken: GetToken, game: GameId = "block-puzzle", asset: 0 | 1 | 2 = 0, onStep?: (s: string) => void, backing?: BackingRef, onStaged?: (s: StagedEntry) => void): Promise<string> {
  await ensureReady(signer, getToken, onStep);
  onStep?.("Opening your Challenge…");
  return (await openEntry({ signer, getToken, game, entry, backing, onStep, onStaged, challenge: true, asset: matchAsset(game, asset) })).key;
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
 * Opener cancels an unjoined Match (or anyone, after its refund deadline) and gets the entry back. With `getToken` the relayer
 * pays the fee and the receipt's rent first (a Player with no SOL can still get out); without it, or when the relayer cannot,
 * the wallet pays.
 */
export const refundMatch = (signer: ChainSigner, id: string, getToken?: GetToken): Promise<string> =>
  getToken
    ? sendSponsoredOrOwn(signer, getToken, async (payer, sponsored) => {
        const ix = await getChain().refundMatchIx(signer.publicKey, payer, id);
        // The server sets the compute budget of a sponsored transaction itself.
        return sponsored ? [ix] : [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix];
      })
    : getChain().refundMatch(signer, id);
