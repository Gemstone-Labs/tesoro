import "./polyfill";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { protectionsPda } from "./native";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { EntryError, matchDelta } from "./ledger";
import { ChallengeError, GAME_IDS, ensureReady, entryHoldings, isChallengeId, newMatchId, queueDeps, refundMatch } from "./match-flow";
import { decodeAll, fetchMatch, gameOf } from "./read";
import { matchOpenedAt } from "./match-id";
import { queueEntry, type Entered } from "./queue";
import { leaderboardBpsFor } from "./season";

/**
 * Backing on chain (tesoro_core Requests and Offers). Reads are public; writes are signed by the
 * Player (Request, apply, accept a directed Offer) or the Backer (Offer, accept an applicant).
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
  /** Request address a directed Offer answers; null for a public Offer. */
  directedTo: string | null;
  status: "open" | "accepted" | "consumed" | "cancelled" | "expired";
  expiresAt: number;
  useBy: number;
  /** TesoroAccount key of the accepted Player. */
  player: string | null;
  /** Address of the accepted Player's Request. */
  request: string | null;
  /** Request addresses of applicants (public Offers). */
  applicants: string[];
  lines: OfferLine[];
  /** The Match this Offer funded, once consumed. */
  matchId: bigint | null;
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

/** Wins, settled count and Gema change per Player over all Matches, from Block Puzzle Sessions, Hold'em tables and Trading Duels. */
async function fetchRecords(players: Set<string>): Promise<Map<string, PlayerForm>> {
  const chain = getChain();
  const rows: any[] = await chain.core.account.matchState.all();
  const settled = rows.filter((m) => enumKey(m.account.inner.status) === "settled" && gameOf(pk(m.account.inner.game)) !== null);
  const bp = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "block-puzzle");
  const sessions = await decodeAll(
    bp.map((m) => BlockPuzzleChain.addresses(big(m.account.id)).session),
    (data) => chain.bp.coder.accounts.decode("session", data),
  );
  const winnerSeat = new Map<string, 0 | 1>();
  bp.forEach((m, i) => {
    const r = sessions[i]?.result;
    if (sessions[i]?.settled && (r === 0 || r === 1)) winnerSeat.set(big(m.account.id).toString(), r);
  });
  const hd = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "holdem");
  if (hd.length) {
    const { getHoldem } = await import("./client");
    const { addresses } = await import("@/games/holdem/chain");
    const program = getHoldem().program;
    const tables = await decodeAll(hd.map((m) => addresses(big(m.account.id)).gameMatch), (data) => program.coder.accounts.decode("gameMatch", data));
    hd.forEach((m, i) => {
      const w = tables[i]?.winner;
      if (w === 0 || w === 1) winnerSeat.set(big(m.account.id).toString(), w);
    });
  }
  const td = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "trading-duel");
  if (td.length) {
    const { getTradingDuel } = await import("./client");
    const { addresses } = await import("@/games/trading-duel/chain");
    const program = getTradingDuel().program;
    const duels = await decodeAll(td.map((m) => addresses(big(m.account.id)).duel), (data) => program.coder.accounts.decode("duel", data));
    td.forEach((m, i) => {
      const w = duels[i]?.winner;
      if (w === 0 || w === 1) winnerSeat.set(big(m.account.id).toString(), w);
    });
  }
  const out = new Map<string, PlayerForm>([...players].map((p) => [p, noForm()]));
  const changes = new Map<string, { at: number; delta: number }[]>();
  for (const m of settled) {
    const w = winnerSeat.get(big(m.account.id).toString());
    if (w === undefined) continue;
    const inner = m.account.inner;
    const id = big(m.account.id);
    const at = matchOpenedAt(id, gameOf(pk(inner.game)));
    const fees = { platformBps: inner.fees.platformBps, studioBps: inner.fees.studioBps, leaderboardBps: leaderboardBpsFor(at) };
    const sides = [inner.a, inner.b];
    sides.forEach((s: any, seat: number) => {
      const player = s && pk(s.player).toBase58();
      const form = player && out.get(player);
      if (!form) return;
      form.record.matches += 1;
      if (seat === w) form.record.wins += 1;
      const backing = pk(s.funder).equals(pk(s.player)) ? null : { shareBps: s.shareBps };
      const delta = matchDelta({ session: null, winner: w === 0 ? "opener" : "joiner", seat: seat as 0 | 1, entry: Number(inner.entry.toString()), fees, backing });
      changes.set(player, [...(changes.get(player) ?? []), { at, delta }]);
    });
  }
  for (const [player, list] of changes) out.get(player)!.pnl = list.sort((a, b) => a.at - b.at).map((c) => c.delta);
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
    game: gameOf(pk(r.game)) ?? "block-puzzle",
    entry: Number(r.entry.toString()),
    expiresAt,
    status,
    live: status === "open" && now() < expiresAt,
    record,
    pnl,
  };
}

const kindOf = (k: any): string | null => {
  const v = k.directed ?? null;
  if (!v) return null;
  const inner = Array.isArray(v) ? v[0] : (v[0] ?? v._0 ?? v);
  return pk(inner).toBase58();
};

function toOffer(row: any, matchId: bigint | null): ChainOffer {
  const o = row.account.inner;
  const directed = kindOf(o.kind);
  const requestKey = (k: number[] | null) => (k ? pk(k).toBase58() : null);
  return {
    address: row.publicKey,
    nonce: big(row.account.nonce),
    backer: pk(o.backer).toBase58(),
    game: gameOf(pk(o.game)) ?? "block-puzzle",
    entry: Number(o.entry.toString()),
    shareBps: o.playerShareBps,
    directedTo: directed,
    status: offerStatus(o.status),
    expiresAt: Number(o.expiresAt.toString()),
    useBy: Number(o.useBy.toString()),
    player: requestKey(o.player),
    request: requestKey(o.request),
    applicants: (o.applicants as number[][]).map((a) => pk(a).toBase58()),
    lines: (o.lines as any[]).map((l) => ({ source: pk(l.source), isOwn: l.isOwn, amount: big(l.amount) })),
    matchId,
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
  const matchOf = (o: any): bigint | null => {
    const inner = o.account.inner;
    const ids = matchRows
      .filter((m) =>
        [m.account.inner.a, m.account.inner.b].some(
          (s: any) => s && pk(s.funder).equals(pk(inner.backer)) && inner.player && pk(s.player).equals(pk(inner.player)),
        ) &&
        pk(m.account.inner.game).equals(pk(inner.game)) &&
        m.account.inner.entry.toString() === inner.entry.toString(),
      )
      .map((m) => big(m.account.id));
    return ids.length ? ids.reduce((x, y) => (x > y ? x : y)) : null;
  };
  const offers = offerRows
    .filter((o) => gameOf(pk(o.account.inner.game)) !== null)
    .map((o) => toOffer(o, enumKey(o.account.inner.status) === "consumed" ? matchOf(o) : null))
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

const config = () => BlockPuzzleChain.addresses(0n).config;
const nonce = () => new BN((BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString());
const metas = (keys: PublicKey[]) => keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));

/** Holdings of an Offer's reserved lines, in the order the program reserved them. */
export const offerHoldings = (backerAccount: PublicKey, lines: OfferLine[]) =>
  lines.map((l) => BlockPuzzleChain.holding(backerAccount, l.source));

/**
 * Before a Break or Self-Exclusion: withdraws everything of the signed-in Account that has not started a Match. Their Match
 * nobody joined is refunded, their open Requests cancelled and their open or accepted Offers released. Matches already paired are left to play out.
 * Returns how many things were withdrawn. The keeper does the same for anything a direct transaction leaves behind.
 */
export async function withdrawOwnOpenItems(signer: ChainSigner): Promise<number> {
  const chain = getChain();
  const me = BlockPuzzleChain.coreAccount(signer.publicKey);
  const [matchRows, reqRows, offerRows]: any[][] = await Promise.all([
    chain.core.account.matchState.all(),
    chain.core.account.requestState.all(),
    chain.core.account.offerState.all(),
  ]);
  const mine = (bytes: number[]) => pk(bytes).equals(me);
  let n = 0;
  for (const m of matchRows) {
    if (enumKey(m.account.inner.status) === "open" && mine(m.account.inner.a.player)) {
      await refundMatch(signer, big(m.account.id));
      n++;
    }
  }
  for (const r of reqRows) {
    if (enumKey(r.account.inner.status) === "open" && mine(r.account.inner.player)) {
      await cancelRequest(signer, r.publicKey);
      n++;
    }
  }
  for (const o of offerRows) {
    if (["open", "accepted"].includes(enumKey(o.account.inner.status)) && mine(o.account.inner.backer)) {
      await cancelOffer(signer, toOffer(o, null));
      n++;
    }
  }
  return n;
}

/** A Player posts a Request for a Game and entry. Creates the Account first if needed. */
export async function postRequest(signer: ChainSigner, game: GameId, entry: number, getToken: GetToken): Promise<{ address: PublicKey; sig: string }> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  const n = nonce();
  const address = PublicKey.findProgramAddressSync([Buffer.from("request"), snap.accountKey.toBuffer(), n.toArrayLike(Buffer, "le", 8)], chain.core.programId)[0];
  const ix = await chain.core.methods
    .createRequest(n, GAME_IDS[game], new BN(entry))
    .accountsPartial({ playerAuthority: signer.publicKey, config: config(), playerAccount: snap.accountKey, protections: protectionsPda(snap.accountKey), request: address, systemProgram: SystemProgram.programId })
    .instruction();
  return { address, sig: await chain.sendBase(signer, [ix]) };
}

export async function cancelRequest(signer: ChainSigner, request: PublicKey) {
  const chain = getChain();
  const ix = await chain.core.methods
    .cancelRequest()
    .accountsPartial({ playerAuthority: signer.publicKey, playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey), request })
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/**
 * A Backer posts an Offer and reserves the entry from their own Gemas. `request` makes it a
 * directed Offer for that Request; omit it for a public Offer.
 */
export async function postOffer(
  signer: ChainSigner,
  a: { game: GameId; entry: number; shareBps: number; request?: PublicKey },
  getToken: GetToken,
): Promise<{ address: PublicKey; sig: string }> {
  const chain = getChain();
  const snap = await ensureReady(signer, getToken);
  const holdings = entryHoldings(snap, a.entry);
  const n = nonce();
  const address = PublicKey.findProgramAddressSync([Buffer.from("offer"), snap.accountKey.toBuffer(), n.toArrayLike(Buffer, "le", 8)], chain.core.programId)[0];
  const ix = await chain.core.methods
    .createOffer(n, GAME_IDS[a.game], new BN(a.entry), a.shareBps, a.request ?? null)
    .accountsPartial({ backerAuthority: signer.publicKey, config: config(), backerAccount: snap.accountKey, offer: address, systemProgram: SystemProgram.programId })
    .remainingAccounts(metas(holdings))
    .instruction();
  return { address, sig: await chain.sendBase(signer, [ix]) };
}

/** The Player accepts an Offer directed at their Request. */
export async function acceptDirected(signer: ChainSigner, request: PublicKey, offer: PublicKey) {
  const chain = getChain();
  const ix = await chain.core.methods
    .acceptDirected()
    .accountsPartial({ playerAuthority: signer.publicKey, playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey), protections: protectionsPda(BlockPuzzleChain.coreAccount(signer.publicKey)), request, offer })
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/** A Player applies to a public Offer with one of their Requests. */
export async function applyToOffer(signer: ChainSigner, request: PublicKey, offer: PublicKey) {
  const chain = getChain();
  const ix = await chain.core.methods
    .applyOffer()
    .accountsPartial({ playerAuthority: signer.publicKey, playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey), protections: protectionsPda(BlockPuzzleChain.coreAccount(signer.publicKey)), request, offer })
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/** The Protections address of the Account that owns a Request (the applicant being accepted). */
async function requestOwnerProtections(request: PublicKey): Promise<PublicKey> {
  const r = await getChain().core.account.requestState.fetch(request);
  return protectionsPda(new PublicKey(Uint8Array.from(r.inner.player)));
}

/** The Backer accepts one applicant of their public Offer. */
export async function acceptApplicant(signer: ChainSigner, request: PublicKey, offer: PublicKey) {
  const chain = getChain();
  const ix = await chain.core.methods
    .acceptApplicant()
    .accountsPartial({ backerAuthority: signer.publicKey, backerAccount: BlockPuzzleChain.coreAccount(signer.publicKey), request, playerProtections: await requestOwnerProtections(request), offer })
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/** The Backer withdraws an Offer that has not started a Match; the reservation is released. */
export async function cancelOffer(signer: ChainSigner, offer: ChainOffer) {
  const chain = getChain();
  const backerAccount = BlockPuzzleChain.coreAccount(signer.publicKey);
  const ix = await chain.core.methods
    .cancelOffer()
    .accountsPartial({
      backerAuthority: signer.publicKey,
      backerAccount,
      offer: offer.address,
      // An accepted Offer hands its Request back to Open, so the Request comes with the call.
      request: offer.status === "accepted" && offer.request ? new PublicKey(offer.request) : null,
    })
    .remainingAccounts(metas(offerHoldings(backerAccount, offer.lines)))
    .instruction();
  return chain.sendBase(signer, [ix]);
}

/** Anyone releases the reservation of an Offer nobody accepted, or nobody used, within 24h. */
export async function expireOffer(signer: ChainSigner, offer: ChainOffer) {
  const chain = getChain();
  const backerAccount = new PublicKey(offer.backer);
  const ix = await chain.core.methods
    .expireOffer()
    .accountsPartial({
      caller: signer.publicKey,
      backerAccount,
      offer: offer.address,
      request: offer.status === "accepted" && offer.request ? new PublicKey(offer.request) : null,
      backerProtections: null,
    })
    .remainingAccounts(metas(offerHoldings(backerAccount, offer.lines)))
    .instruction();
  return chain.sendBase(signer, [ix]);
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
  if (offer.player !== BlockPuzzleChain.coreAccount(signer.publicKey).toBase58()) throw new BackingError("not-yours");
  if (now() >= offer.useBy) throw new BackingError("expired");
  if (offer.game !== game || offer.entry !== entry) throw new BackingError("not-accepted");
  return offer;
}

const backerAccountOf = (o: ChainOffer) => new PublicKey(o.backer);

/**
 * The async Block Puzzle client opens (and joins) its Session in the same transaction as the core
 * instruction. When the client has those builders, bundle them; the earlier flow starts the
 * Session after pairing and needs nothing here.
 */
type SessionIxs = {
  openSessionIx?: (payer: PublicKey, id: bigint, opener: PublicKey) => Promise<TransactionInstruction>;
  joinSessionIx?: (payer: PublicKey, id: bigint, joiner: PublicKey) => Promise<TransactionInstruction>;
};
const sessionIxs = (chain: object) => chain as SessionIxs;

async function openBacked(signer: ChainSigner, id: bigint, offer: ChainOffer) {
  const chain = getChain();
  const a = BlockPuzzleChain.addresses(id);
  const backerAccount = backerAccountOf(offer);
  const ix = await chain.core.methods
    .openMatchBacked(new BN(id.toString()), GAME_IDS[offer.game], new BN(offer.entry))
    .accountsPartial({
      playerAuthority: signer.publicKey,
      config: a.config,
      playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey),
      protections: protectionsPda(BlockPuzzleChain.coreAccount(signer.publicKey)),
      offer: offer.address,
      backerAccount,
      backerProtections: protectionsPda(backerAccount),
      matchState: a.match,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(metas(offerHoldings(backerAccount, offer.lines)))
    .instruction();
  const session = offer.game === "block-puzzle" ? await sessionIxs(chain).openSessionIx?.(signer.publicKey, id, signer.publicKey) : undefined;
  return chain.sendBase(signer, session ? [ix, session] : [ix]);
}

async function joinBacked(signer: ChainSigner, id: bigint, offer: ChainOffer) {
  const chain = getChain();
  const backerAccount = backerAccountOf(offer);
  const ix = await chain.core.methods
    .joinMatchBacked()
    .accountsPartial({
      playerAuthority: signer.publicKey,
      playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey),
      protections: protectionsPda(BlockPuzzleChain.coreAccount(signer.publicKey)),
      offer: offer.address,
      backerAccount,
      backerProtections: protectionsPda(backerAccount),
      matchState: BlockPuzzleChain.addresses(id).match,
      openerProtections: await chain.openerProtections(id),
    })
    .remainingAccounts(metas(offerHoldings(backerAccount, offer.lines)))
    .instruction();
  const session = offer.game === "block-puzzle" ? await sessionIxs(chain).joinSessionIx?.(signer.publicKey, id, signer.publicKey) : undefined;
  return chain.sendBase(signer, session ? [ix, session] : [ix]);
}

/** Queue under a Backing: join the oldest open Match at this entry, else open one. The Player is never debited. */
export async function enterQueueBacked(signer: ChainSigner, backing: string, game: GameId, entry: number, getToken: GetToken, onStep?: (s: string) => void, asset: 0 | 1 | 2 = 0): Promise<Entered> {
  const snap = await ensureReady(signer, getToken);
  const offer = await requireBacking(signer, backing, game, entry);
  return queueEntry({
    ...queueDeps(signer, snap.accountKey, game, entry, asset),
    join: (id) => joinBacked(signer, id, offer),
    open: (id) => openBacked(signer, id, offer),
    // Another Player joined first: only move on while the Offer is still ours to use.
    canRetry: async () => (await fetchOffer(offer.address))?.status === "accepted",
    onStep,
  });
}

/** Challenge under a Backing: open a Match only reachable through its link. */
export async function createChallengeBacked(signer: ChainSigner, backing: string, game: GameId, entry: number, getToken: GetToken, asset: 0 | 1 | 2 = 0) {
  await ensureReady(signer, getToken);
  const offer = await requireBacking(signer, backing, game, entry);
  const id = newMatchId(true, game, asset);
  return { id, sig: await openBacked(signer, id, offer) };
}

/** Opening a Challenge link under a Backing joins it with the Backer's reserved Gemas. */
export async function joinChallengeBacked(signer: ChainSigner, backing: string, id: bigint, getToken: GetToken) {
  const snap = await ensureReady(signer, getToken);
  const m = await fetchMatch(id, snap.accountKey);
  if (!m) throw new ChallengeError("missing");
  if (!m.challenge && !isChallengeId(id)) throw new ChallengeError("not-challenge");
  if (m.seat !== null) return;
  if (m.status !== "open") throw new ChallengeError("taken");
  const offer = await requireBacking(signer, backing, m.game, m.entry);
  await joinBacked(signer, id, offer);
}

export { EntryError };
