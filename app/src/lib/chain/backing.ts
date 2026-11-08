import "./polyfill";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { accountOfSigner, BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { gameRecordPda } from "./game-record";
import { protectionsPda } from "./native";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { EntryError } from "./ledger";
import { ChallengeError, GAME_IDS, enterQueue, createChallenge, joinChallenge, ensureReady, refundMatch } from "./match-flow";
import { coreIx } from "./entry";
import { basketPda, countersPda, spillPda } from "./basket";
import { freeOf, readEntryStores, type BackingRef } from "./entry";
import { DrawError } from "./draw";
import { fetchMatch, gameOf, matchKeyOfState, requireGame } from "./read";
import type { Entered } from "./queue";

/**
 * Backing on chain (tesoro_core Requests and Offers). Reads are public; writes are signed by the
 * Player (Request, accept an Offer) or the Backer (an Offer on a Request).
 * See docs/tesoro-core.md for the rules and docs/games/backing.md for the flow.
 */

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());
const enumKey = (o: object) => Object.keys(o)[0];
const now = () => Math.floor(Date.now() / 1000);

export const BACKING_TTL_SECS = 24 * 60 * 60;

/** A Player's real settled-Match record. `matches` is the sample size the win rate is measured on. */
export interface PlayerRecord {
  /** Settled Matches with a winner (draws and refunds are not counted). */
  matches: number;
  wins: number;
}

export interface ChainRequest {
  address: PublicKey;
  nonce: bigint;
  /** TesoroAccount key of the Player. */
  player: string;
  game: GameId;
  entry: number;
  expiresAt: number;
  status: "open" | "accepted" | "cancelled";
  /** Open and not expired. */
  live: boolean;
  record: PlayerRecord;
  /** The Player's Gema change in each Match with a winner, oldest first, by the Account page's rule (a backed loss costs them 0). */
  pnl: number[];
}

export interface OfferLine {
  source: PublicKey;
  isOwn: boolean;
  amount: bigint;
}

export interface ChainOffer {
  address: PublicKey;
  nonce: bigint;
  /** TesoroAccount key of the Backer. */
  backer: string;
  game: GameId;
  entry: number;
  shareBps: number;
  status: "open" | "accepted" | "consumed" | "cancelled" | "expired";
  expiresAt: number;
  useBy: number;
  /** TesoroAccount key of the accepted Player. */
  player: string | null;
  /** The Request this Offer answers: every Offer is made on one Request. */
  request: string;
  lines: OfferLine[];
  /** Key (`<opener>-<n>`) of the live Match this Offer funded, once consumed; null when that Match is closed or unknown. */
  matchId: string | null;
  /** Same as `matchId` when that Match is still open, nobody joined and its refund deadline has passed: the Backer can refund it. Else null. */
  refundableMatchId: string | null;
  /** A Backing Ticket is open on this Offer (the Requester is staging the Backer's entry). */
  ticketOpen: boolean;
}

export interface BackingBoard {
  requests: ChainRequest[];
  offers: ChainOffer[];
  fetchedAt: number;
}

const requestStatus = (o: object) => enumKey(o) as ChainRequest["status"];
const offerStatus = (o: object) => enumKey(o) as ChainOffer["status"];

interface PlayerForm {
  record: PlayerRecord;
  pnl: number[];
}
const noForm = (): PlayerForm => ({ record: { matches: 0, wins: 0 }, pnl: [] });

/**
 * Wins, settled count and Gema change per Player over all finished Matches, from the Match history
 * (`/api/player-forms`): a finished Match's account is closed, so the chain no longer has them. An
 * unavailable history gives every Player an empty record.
 */
async function fetchRecords(players: Set<string>, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<Map<string, PlayerForm>> {
  const out = new Map<string, PlayerForm>([...players].map((p) => [p, noForm()]));
  try {
    const res = await fetcher(`/api/player-forms?players=${[...players].join(",")}`);
    if (!res.ok) return out;
    const forms = (await res.json()) as Record<string, { matches: number; wins: number; pnl: number[] }>;
    for (const [player, f] of Object.entries(forms)) if (out.has(player)) out.set(player, { record: { matches: f.matches, wins: f.wins }, pnl: f.pnl });
  } catch {
    // no history: records stay empty
  }
  return out;
}

function toRequest(row: any, { record, pnl }: PlayerForm): ChainRequest {
  const r = row.account.inner;
  const status = requestStatus(r.status);
  const expiresAt = Number(r.expiresAt.toString());
  return {
    address: row.publicKey,
    nonce: big(row.account.nonce),
    player: pk(r.player).toBase58(),
    game: requireGame(pk(r.game)),
    entry: Number(r.entry.toString()),
    expiresAt,
    status,
    live: status === "open" && now() < expiresAt,
    record,
    pnl,
  };
}

function toOffer(row: any, matchId: string | null, refundableMatchId: string | null = null): ChainOffer {
  const o = row.account.inner;
  const requestKey = (k: number[] | null) => (k ? pk(k).toBase58() : null);
  return {
    address: row.publicKey,
    nonce: big(row.account.nonce),
    backer: pk(o.backer).toBase58(),
    game: requireGame(pk(o.game)),
    entry: Number(o.entry.toString()),
    shareBps: o.playerShareBps,
    status: offerStatus(o.status),
    expiresAt: Number(o.expiresAt.toString()),
    useBy: Number(o.useBy.toString()),
    player: requestKey(o.player),
    request: pk(o.request).toBase58(),
    // An Offer reserves an amount in the Backer's basket, not lines: kept empty for callers written for line reservations.
    lines: [],
    matchId,
    refundableMatchId,
    ticketOpen: !!o.ticketOpen,
  };
}

/** Every Request and Offer on chain, with each Player's real record (count, wins). */
export async function fetchBackingBoard(): Promise<BackingBoard> {
  const chain = getChain();
  const [reqRows, offerRows, matchRows]: any[][] = await Promise.all([
    chain.core.account.requestState.all(),
    chain.core.account.offerState.all(),
    chain.core.account.matchState.all(),
  ]);
  const players = new Set<string>(reqRows.map((r) => pk(r.account.inner.player).toBase58()));
  const records = players.size ? await fetchRecords(players) : new Map<string, PlayerForm>();
  const requests = reqRows
    .filter((r) => gameOf(pk(r.account.inner.game)) !== null)
    .map((r) => toRequest(r, records.get(pk(r.account.inner.player).toBase58()) ?? noForm()))
    .sort((a, b) => b.expiresAt - a.expiresAt);
  // A consumed Offer funded the newest Match with the same Backer, Player, Game and entry.
  const matchOf = (o: any): { id: string; refundable: boolean } | null => {
    const inner = o.account.inner;
    const rows = matchRows
      .filter((m) =>
        [m.account.inner.a, m.account.inner.b].some(
          (s: any) => s && pk(s.funder).equals(pk(inner.backer)) && inner.player && pk(s.player).equals(pk(inner.player)),
        ) &&
        pk(m.account.inner.game).equals(pk(inner.game)) &&
        m.account.inner.entry.toString() === inner.entry.toString(),
      )
      .sort((x, y) => Number(big(y.account.inner.openedAt) - big(x.account.inner.openedAt)));
    if (!rows.length) return null;
    const m = rows[0].account.inner;
    const unjoinedExpired = enumKey(m.stage) === "open" && !m.b && Number(m.deadline.toString()) <= now();
    return { id: matchKeyOfState(rows[0].account), refundable: unjoinedExpired };
  };
  const offers = offerRows
    .filter((o) => gameOf(pk(o.account.inner.game)) !== null)
    .map((o) => {
      const m = enumKey(o.account.inner.status) === "consumed" ? matchOf(o) : null;
      return toOffer(o, m?.id ?? null, m?.refundable ? m.id : null);
    })
    .sort((a, b) => b.expiresAt - a.expiresAt);
  return { requests, offers, fetchedAt: Date.now() };
}

/** The live (open, not expired) Requests of one Player, soonest to expire last. `record` is that Player's own, already known to the caller; `pnl` is left empty. */
export async function fetchLiveRequests(player: string, record: PlayerRecord): Promise<ChainRequest[]> {
  const rows: any[] = await getChain().core.account.requestState.all();
  return rows
    .filter((r) => pk(r.account.inner.player).toBase58() === player && gameOf(pk(r.account.inner.game)) !== null)
    .map((r) => toRequest(r, { record, pnl: [] }))
    .filter((r) => r.live)
    .sort((a, b) => b.expiresAt - a.expiresAt);
}

export async function fetchOffer(address: PublicKey): Promise<ChainOffer | null> {
  const acc = await getChain().core.account.offerState.fetchNullable(address);
  return acc && gameOf(pk(acc.inner.game)) !== null ? toOffer({ publicKey: address, account: acc }, null) : null;
}

// ---- writes ---------------------------------------------------------------------------------

const config = () => PublicKey.findProgramAddressSync([Buffer.from("config")], getChain().core.programId)[0];
const nonce = () => new BN((BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString());

/**
 * The Backer refunds a Match nobody joined, once its deadline has passed (the relayer pays). The opener's own refund or the keeper's safety
 * sweep may land first: then the Match is gone or already refunding, which is the outcome the Backer wanted, so this returns null instead of failing.
 * Returns the signature, or null when someone else already refunded it.
 */
export async function refundBackedMatch(signer: ChainSigner, matchId: string, getToken: GetToken): Promise<string | null> {
  try {
    return await refundMatch(signer, matchId, getToken);
  } catch (e) {
    const m = await fetchMatch(matchId, null).catch(() => undefined);
    if (m === null || (m && m.status !== "open")) return null;
    throw e;
  }
}

/** A Player posts a Request for a Game and entry. Creates the Account first if needed. */
export async function postRequest(signer: ChainSigner, game: GameId, entry: number, getToken: GetToken): Promise<{ address: PublicKey; sig: string }> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  const n = nonce();
  const address = PublicKey.findProgramAddressSync([Buffer.from("request"), snap.accountKey.toBuffer(), n.toArrayLike(Buffer, "le", 8)], chain.core.programId)[0];
  const ix = await chain.core.methods
    .createRequest(n, GAME_IDS[game], new BN(entry))
    .accountsPartial({ playerAuthority: signer.publicKey, config: config(), gameRecord: gameRecordPda(GAME_IDS[game]), playerAccount: snap.accountKey, protections: protectionsPda(snap.accountKey), request: address, systemProgram: SystemProgram.programId })
    .instruction();
  return { address, sig: await chain.sendBase(signer, [ix]) };
}

export const cancelRequestIx = (owner: PublicKey, request: PublicKey) =>
  getChain().core.methods
    .cancelRequest()
    .accountsPartial({ playerAuthority: owner, playerAccount: BlockPuzzleChain.coreAccount(owner), request })
    .instruction();

export async function cancelRequest(signer: ChainSigner, request: PublicKey) {
  return getChain().sendBase(signer, [await cancelRequestIx(signer.publicKey, request)]);
}

/** A Backer answers a Request with an Offer for its game and entry, reserving the entry from their own Gemas. */
export async function postOffer(
  signer: ChainSigner,
  a: { game: GameId; entry: number; shareBps: number; request: PublicKey },
  getToken: GetToken,
): Promise<{ address: PublicKey; sig: string }> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  // The Offer reserves the entry in the Backer's pool: the Gemas must be free (not already reserved, not in a Ticket).
  const stores = await readEntryStores(snap.accountKey);
  if (freeOf(stores) < BigInt(a.entry)) throw new DrawError("insufficient");
  const n = nonce();
  const address = PublicKey.findProgramAddressSync([Buffer.from("offer"), snap.accountKey.toBuffer(), n.toArrayLike(Buffer, "le", 8)], chain.core.programId)[0];
  const ix = coreIx(
    "create_offer",
    {
      backerAuthority: signer.publicKey,
      config: config(),
      request: a.request,
      gameRecord: gameRecordPda(GAME_IDS[a.game]),
      backerAccount: snap.accountKey,
      protections: protectionsPda(snap.accountKey),
      basket: basketPda(snap.accountKey),
      spill: spillPda(snap.accountKey),
      counters: countersPda(snap.accountKey),
      offer: address,
      systemProgram: SystemProgram.programId,
    },
    { nonce: new BN(n.toString()), playerShareBps: a.shareBps },
  );
  return { address, sig: await chain.sendBase(signer, [ix]) };
}

/** The Player accepts an Offer made on their Request. */
export async function acceptOffer(signer: ChainSigner, request: PublicKey, offer: PublicKey) {
  const chain = getChain();
  const ix = await chain.core.methods
    .acceptOffer()
    .accountsPartial({ playerAuthority: signer.publicKey, playerAccount: accountOfSigner(signer), protections: protectionsPda(accountOfSigner(signer)), request, offer })
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/**
 * The Backer withdraws an Offer that has not started a Match; the reservation is released. The Backer's Protections
 * trail, writable: the W3 core gives the Offer's Entry Limit count back there, and the current core ignores them.
 */
export function cancelOfferIx(owner: PublicKey, offer: PublicKey, acceptedRequest: PublicKey | null) {
  const backerAccount = BlockPuzzleChain.coreAccount(owner);
  return coreIx(
    "cancel_offer",
    {
      backerAuthority: owner,
      backerAccount,
      basket: basketPda(backerAccount),
      spill: spillPda(backerAccount),
      counters: countersPda(backerAccount),
      offer,
      // An accepted Offer hands its Request back to Open, so the Request comes with the call.
      request: acceptedRequest ?? undefined,
    },
    {},
    [{ pubkey: protectionsPda(backerAccount), isSigner: false, isWritable: true }],
  );
}

export async function cancelOffer(signer: ChainSigner, offer: ChainOffer) {
  return getChain().sendBase(signer, [cancelOfferIx(signer.publicKey, offer.address, offer.status === "accepted" ? new PublicKey(offer.request) : null)]);
}

/**
 * Anyone releases the reservation of an Offer nobody accepted, or nobody used, within 24h. The Backer's Protections go
 * writable: the W3 core gives the Offer's Entry Limit count back there, where this IDL still marks them read-only.
 */
export function expireOfferIx(caller: PublicKey, offer: ChainOffer) {
  const backerAccount = new PublicKey(offer.backer);
  const backerProtections = protectionsPda(backerAccount);
  const ix = coreIx("expire_offer", {
    caller,
    backerAccount,
    basket: basketPda(backerAccount),
    spill: spillPda(backerAccount),
    counters: countersPda(backerAccount),
    offer: offer.address,
    request: offer.status === "accepted" ? new PublicKey(offer.request) : undefined,
    backerProtections,
  });
  for (const m of ix.keys) if (m.pubkey.equals(backerProtections)) m.isWritable = true;
  return ix;
}

export async function expireOffer(signer: ChainSigner, offer: ChainOffer) {
  return getChain().sendBase(signer, [expireOfferIx(signer.publicKey, offer)]);
}

// ---- entering a Match under a Backing --------------------------------------------------------

export class BackingError extends Error {
  constructor(readonly code: "missing" | "not-yours" | "not-accepted" | "expired" | "used") {
    super(
      {
        missing: "This Backing does not exist.",
        "not-yours": "This Backing was accepted for another Player.",
        "not-accepted": "This Backing is not accepted yet.",
        expired: "This Backing expired. The Backer's Gemas are released.",
        used: "This Backing already funded a Match.",
      }[code],
    );
  }
}

/** The Offer must be Accepted for this Account and still inside its 24h use-by window. */
async function requireBacking(signer: ChainSigner, address: string, game: GameId, entry: number): Promise<ChainOffer> {
  const offer = await fetchOffer(new PublicKey(address));
  if (!offer) throw new BackingError("missing");
  if (offer.status === "consumed") throw new BackingError("used");
  if (offer.status !== "accepted") throw new BackingError(offer.status === "expired" ? "expired" : "not-accepted");
  if (offer.player !== accountOfSigner(signer).toBase58()) throw new BackingError("not-yours");
  if (now() >= offer.useBy) throw new BackingError("expired");
  if (offer.game !== game || offer.entry !== entry) throw new BackingError("not-accepted");
  return offer;
}

const backingRefOf = (o: ChainOffer): BackingRef => ({ offer: o.address, backerAccount: new PublicKey(o.backer) });

/** Queue under a Backing: join the oldest open Match at this entry, else open one. The Player is never debited. */
export async function enterQueueBacked(signer: ChainSigner, backing: string, game: GameId, entry: number, getToken: GetToken, onStep?: (s: string) => void, asset: 0 | 1 | 2 = 0): Promise<Entered> {
  await ensureReady(signer, getToken);
  const offer = await requireBacking(signer, backing, game, entry);
  // Another Player joined first: only move on while the Offer is still ours to use.
  return enterQueue(signer, entry, getToken, game, onStep, asset, backingRefOf(offer), async () => (await fetchOffer(offer.address))?.status === "accepted");
}

/** Challenge under a Backing: open a Match only reachable through its link. */
export async function createChallengeBacked(signer: ChainSigner, backing: string, game: GameId, entry: number, getToken: GetToken, asset: 0 | 1 | 2 = 0) {
  await ensureReady(signer, getToken);
  const offer = await requireBacking(signer, backing, game, entry);
  const id = await createChallenge(signer, entry, getToken, game, asset, undefined, backingRefOf(offer));
  return { id };
}

/** Opening a Challenge link under a Backing joins it with the Backer's reserved Gemas. */
export async function joinChallengeBacked(signer: ChainSigner, backing: string, key: string, getToken: GetToken) {
  const snap = await ensureReady(signer, getToken);
  const m = await fetchMatch(key, snap.accountKey);
  if (!m) throw new ChallengeError("missing");
  if (!m.challenge) throw new ChallengeError("not-challenge");
  if (m.seat !== null) return;
  if (m.status !== "open") throw new ChallengeError("taken");
  const offer = await requireBacking(signer, backing, m.game, m.entry);
  await joinChallenge(signer, key, getToken, backingRefOf(offer));
}

export { EntryError };
