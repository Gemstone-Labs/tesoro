import { PublicKey, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { decodeBattle } from "@/games/vanguard/decode";
import { VANGUARD_PROGRAM_ID } from "@/games/vanguard/chain";
import type { MatchPage } from "@/server/history/reads";
import type { GameId } from "@/lib/mock/types";
import { getChain, getHoldem, getTradingDuel } from "./client";
import { gameOfProgram } from "./games";
import { matchAddressOf, matchKeyOf, parseMatchKey } from "./match-id";
import { battleOf, duelOf, holdemTableOf, sessionOf } from "./game-accounts";
import { canJoinSeat as seatsCanPair } from "./queue";
import { fetchLeaderboardTerms } from "./leaderboard";
import { leaderboardBpsFor } from "./season";
import { readAccountState } from "./account-state";
import { isCurrentPosition } from "./position-size";
import { fetchRoutedState } from "./snapshot-wire";
import type { NativeInfo, NativeMarket } from "./native";
import { OVERFLOW_DISC, OVERFLOW_OWNER_AT, decodeOverflowRecord, type WaitingRecord } from "./overflow";
import { matchPda, type LineRef } from "./basket";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());

export type MatchStatus = "open" | "active" | "settled" | "refunded";

/** A Match as one Account sees it (the signed-in one, or the Account a page is about). */
export interface ChainMatch {
  /** `<opener>-<n>`: the opener's Account and the opener's counter (see match-id.ts). */
  id: string;
  /** TesoroAccount key of whoever opened the Match, and the opener's counter value. */
  opener: string;
  n: bigint;
  game: GameId;
  /** Address of the tesoro_core MatchState. */
  address: PublicKey;
  status: MatchStatus;
  /** A settled or refunding run is under way (chunks still moving Gemas): the result is fixed, the Match is not closed. */
  running: "settling" | "refunding" | null;
  entry: number;
  /** Which side of the Match this Account is on, null when not a participant. */
  seat: 0 | 1 | null;
  /** TesoroAccount key of the opponent, null until one joins. */
  opponent: string | null;
  /** Unix seconds after which anyone may refund an unfinished Match. */
  deadline: number;
  /** Milliseconds since the epoch the Match opened (`MatchState.inner.opened_at`). */
  openedAt: number;
  /** Challenge Matches are played by invitation and never enter the Queue (`meta.challenge`). */
  challenge: boolean;
  /** Trading Duel asset index (0 SOL, 1 ETH, 2 HYPE); 0 for every other Game (`meta.asset`). */
  asset: number;
  /** Who plays and who funds each entry; they differ on a backed side. */
  sides: [MatchSide, MatchSide | null];
  /** Seat this Account funds without playing (it is the Backer), else null. */
  backerSeat: 0 | 1 | null;
  /** The Backing this Account is part of in this Match (as the backed Player or as the Backer), else null. */
  backing: { seat: 0 | 1; player: string; funder: string; shareBps: number } | null;
  fees: { platformBps: number; studioBps: number; leaderboardBps: number };
  /** The winning seat of a finished Match (null for a draw, a refund or while unsettled). */
  winner: "opener" | "joiner" | null;
  /** Block Burst: set as soon as the Match is opened (the opener plays before anyone is paired). */
  session: {
    settled: boolean;
    joined: boolean;
    result: "opener" | "joiner" | "draw";
    scores: [number, number];
    /** Zero until settlement: the Seed is hidden from everyone until their own run begins. */
    seed: bigint;
    /** Opener must begin before this; a joiner's deadline is `deadline` (zero until joined). */
    openerDeadline: number;
    deadline: number;
  } | null;
}

export interface MatchSide {
  /** TesoroAccount key of whoever plays. */
  player: string;
  /** TesoroAccount key of whoever put the Gemas in the Pot. */
  funder: string;
  /** The Player's share of the surplus in bps (0 unless backed). */
  shareBps: number;
}

/**
 * One line of the Account's basket or spill (tesoro_core economy upgrade): Gemas of one Source,
 * own or won, in one class and tranche, with the planned repayment date that orders the draw.
 * Named `holding` in the Wallet code for historical reasons; there is no Holding account any more.
 * Offer reservations are account-wide (`AccountSnapshot.reservedTotal`), so `reserved` is 0 here.
 */
export interface ChainHolding {
  /** Stable id of the line (`side:dueAt:source:class:tranche`). */
  key: string;
  /** The `LineRef` argument of Redeem, Return and Instant Redeem. */
  line: LineRef;
  /** Where the line lives: the basket or the spill. */
  store: "basket" | "spill";
  source: PublicKey;
  position: PublicKey;
  isOwn: boolean;
  /** Class (0 Platform, 1 Studio, 2 Leaderboard, 3 General, 3+n Extension n); fee classes are never played. */
  classId: number;
  tranche: number;
  /** Planned repayment, unix seconds: "ready by". Also the draw order (earliest first). */
  dueAt: number;
  amount: bigint;
  /** Always 0: Offers reserve per Account, not per line. */
  reserved: bigint;
  /** Gemas of the line (the line itself is never partly reserved). */
  free: bigint;
  /** Gemas Redeem would pay now, with the Source's earned yield landed first. */
  redeemable: bigint;
  /** Gemas Instant Redeem can sell, won or own (founder, 2026-10-22): what is still waiting on yield once `redeemable` is redeemed in full. */
  pending: bigint;
  /** The Yield Fee a cash-out of this line pays (0 for the fee classes) and the Pool's share of it: the Source's snapshot (ticket 31). */
  yieldFeeBps: number;
  poolBps: number;
  /** The Source's Debt in Gemas: what `return_own` can still cancel. */
  sourceDebt: bigint;
  /** The Source's price at its Advance: one Gema is `unitNum / unitDen` Source-asset base units (`unitDen` = price in micro-USD). */
  unitNum: bigint;
  unitDen: bigint;
  /** Owner Account key of the Source's Position. */
  sourceOwner: string;
  asset: "SOL" | "ETH" | "HYPE";
  /** The Source's Position holds simSOL custody: Redeem pays simSOL on Solana. */
  native: boolean;
  /** The staking token's mint when the Source's Position holds a real staking token (mainnet); null for simSOL custody. */
  stakeMint: PublicKey | null;
  /** The Source belongs to an Ethereum or HyperEVM Position (Redeem pays on that chain through the bridge). */
  eth: { vault: string; id: bigint } | null;
  /** Index of the Source on its Position. */
  sourceIndex: number;
  /** The Source is the Position's open Advance (its yield is still landing). */
  open: boolean;
  /** Checkpoint pages a Redeem of this line must pass, with the Source's book (see `bookAccounts`). */
  accounts: PublicKey[];
}

export interface StoreSummary {
  len: number;
  capacity: number;
  /** Spill only: slots held for Matches in flight. */
  roomReserved: number;
  flags: number;
  sponsoredLamports: bigint;
}

export interface ChainAdvance {
  source: PublicKey;
  gemasIssued: number;
  horizonMonths: number;
  /** Gemas still owed to the Position (outstanding minus repaid by yield). */
  debtGemas: number;
}

export interface ChainPosition {
  address: PublicKey;
  asset: "SOL" | "ETH" | "HYPE";
  /** Principal in asset units (not base units). */
  principal: number;
  apy: number;
  status: "locked" | "unlocked";
  /** Advances ever taken on this Position. */
  advances: number;
  advance: ChainAdvance | null;
  /** Debt in asset units. */
  debt: number;
  yieldAccrued: number;
  /** simSOL custody details, for Solana-native Positions. */
  native: NativeInfo | null;
  /** Ethereum or HyperEVM Position: the vault and its position id. */
  eth: { vault: string; id: bigint } | null;
}

export interface AccountSnapshot {
  /** The TesoroAccount exists on chain. */
  exists: boolean;
  accountKey: PublicKey;
  lamports: number;
  ownTotal: bigint;
  wonTotal: bigint;
  /** Gemas held back for open Offers (account-wide). */
  reservedTotal: bigint;
  /** Gemas an open Entry Ticket still has to stage. */
  ticketNeed: bigint;
  /** Fee-class Gemas (Studio Fee lines of an outside studio's Games): never played. */
  feeTotal: bigint;
  /** Basket and spill headers: capacity and fullness, for the room an entry and a join may need. */
  stores: { basket: StoreSummary; spill: StoreSummary } | null;
  /** One entry per basket and spill line, in the draw's merged order. */
  holdings: ChainHolding[];
  positions: ChainPosition[];
  matches: ChainMatch[];
  /** sim_lst pool, price feed and simSOL balance (SIMULATED yield). Null until read. */
  market: NativeMarket | null;
  /** Matches this Account funded as a Backer without playing them. */
  funded: ChainMatch[];
  /** Overflow records: Gemas that found no room in the stores (a win, a refund, a prize) and wait to be claimed. */
  waiting?: WaitingRecord[];
  /** False while `matches` and `funded` are not read yet (they arrive after the rest of the Account). */
  matchesLoaded: boolean;
  fetchedAt: number;
}

const enumKey = (o: object) => Object.keys(o)[0];

/** The Game a tesoro_core Match belongs to, or null for a program this app does not play. */
export const gameOf = gameOfProgram;

/** The Game of a program id this app plays; throws for any other, so a Match of an unknown program is never shown as another Game. */
export function requireGame(game: PublicKey): GameId {
  const g = gameOf(game);
  if (!g) throw new Error(`Unknown game program ${game.toBase58()}`);
  return g;
}

/** The key (`<opener>-<n>`) of a decoded MatchState. */
export const matchKeyOfState = (state: any): string => matchKeyOf({ opener: pk(state.inner.id.opener).toBase58(), n: big(state.inner.id.n) });

/** Anchor's decoded `MatchState` (camelCase) plus the finished game account that names the winner, as a ChainMatch. */
export function toChainMatch(state: any, me: PublicKey | null, session: any | null, table: any | null = null): ChainMatch {
  const m = state.inner;
  const a = pk(m.a.player).toBase58();
  const b = m.b ? pk(m.b.player).toBase58() : null;
  const mine = me?.toBase58();
  const seat = mine === a ? 0 : mine && mine === b ? 1 : null;
  const stage = enumKey(m.stage);
  const kind = m.run ? enumKey(m.run.kind) : null;
  const status: MatchStatus = stage === "open" ? "open" : stage === "closed" ? (kind === "win" || kind === "draw" ? "settled" : "refunded") : "active";
  const running = stage === "settling" ? "settling" : stage === "refunding" ? "refunding" : null;
  const side = (s: any): MatchSide => ({ player: pk(s.player).toBase58(), funder: pk(s.funder).toBase58(), shareBps: s.shareBps });
  const sides: [MatchSide, MatchSide | null] = [side(m.a), m.b ? side(m.b) : null];
  const backerSeat = mine ? ([0, 1] as const).find((i) => sides[i] && sides[i].funder === mine && sides[i].player !== mine) ?? null : null;
  const backedSeat = seat !== null && sides[seat]?.funder !== sides[seat]?.player ? seat : backerSeat;
  const backedSide = backedSeat === null ? null : sides[backedSeat];
  const openedAt = Number(big(m.openedAt)) * 1000;
  const opener = pk(m.id.opener).toBase58();
  const n = big(m.id.n);
  return {
    id: matchKeyOf({ opener, n }),
    opener,
    n,
    game: requireGame(pk(m.game)),
    address: matchPda(pk(m.id.opener), n),
    status,
    running,
    entry: Number(m.entry.toString()),
    seat,
    opponent: seat === 0 ? b : seat === 1 ? a : null,
    deadline: Number(m.deadline.toString()),
    openedAt,
    challenge: !!m.meta.challenge,
    asset: m.meta.asset ?? 0,
    sides,
    backerSeat,
    backing:
      backedSeat !== null && backedSide
        ? { seat: backedSeat, player: backedSide.player, funder: backedSide.funder, shareBps: backedSide.shareBps }
        : null,
    fees: { platformBps: m.terms.platformBps, studioBps: m.terms.studioBps, leaderboardBps: leaderboardBpsFor(openedAt) },
    winner: status === "settled" && table ? (table.winner === 0 ? "opener" : table.winner === 1 ? "joiner" : null) : null,
    session: session
      ? {
          settled: session.settled,
          joined: session.joined,
          openerDeadline: Number(session.openerDeadline.toString()),
          result: (["opener", "joiner", "draw"] as const)[session.result as number],
          scores: (session.scores as number[]).map(Number) as [number, number],
          seed: big(session.seed),
          deadline: Number(session.deadline.toString()),
        }
      : null,
  };
}

/**
 * Reads one Match (and its Session, when it has one). `id` is the Match key. A Match whose account is
 * already closed comes from the history (server route), which has its result; null when nobody knows it.
 */
export async function fetchMatch(id: string, me: PublicKey | null): Promise<ChainMatch | null> {
  const address = matchAddressOf(id);
  if (!address) return null;
  const chain = getChain();
  await fetchLeaderboardTerms(chain.core.provider.connection).catch(() => undefined);
  const state = await chain.core.account.matchState.fetchNullable(address);
  if (!state) return fetchClosedMatch(id, me);
  const game = gameOf(pk(state.inner.game));
  if (game === null) return null;
  const finished = enumKey(state.inner.stage) === "closed" || enumKey(state.inner.stage) === "settling" || enumKey(state.inner.stage) === "refunding";
  if (game === "holdem") return toChainMatch(state, me, null, finished ? await holdemTable(address) : null);
  if (game === "trading-duel") return toChainMatch(state, me, null, finished ? await duelAccount(address) : null);
  if (game === "vanguard") return toChainMatch(state, me, null, finished ? await battleOnBase(address) : null);
  const session = await chain.bp.account.session.fetchNullable(sessionOf(address)).catch(() => null);
  return toChainMatch(state, me, session);
}

/** A closed Match from the history route (its account no longer exists): the result, sides and Fees it settled with. */
async function fetchClosedMatch(id: string, me: PublicKey | null): Promise<ChainMatch | null> {
  try {
    const res = await fetch(`/api/match/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return chainMatchFromPage((await res.json()) as MatchPage, me);
  } catch {
    return null;
  }
}

const GAME_IDS_ALL: readonly string[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];
const gameFromHistory = (id: string): GameId | null => (GAME_IDS_ALL.includes(id) ? (id as GameId) : null);

/** The ChainMatch of a history MatchPage (a Match whose account is closed). */
export function chainMatchFromPage(p: MatchPage, me: PublicKey | null): ChainMatch | null {
  const key = parseMatchKey(p.id);
  const game = gameFromHistory(p.game);
  if (!key || !game) return null;
  const mine = me?.toBase58();
  const sides: [MatchSide, MatchSide | null] = [
    { player: p.sides[0].player, funder: p.sides[0].funder, shareBps: p.parties.find((x) => x.side === 0 && x.role === "player")?.shareBps ?? 0 },
    p.sides[1] ? { player: p.sides[1].player, funder: p.sides[1].funder, shareBps: p.parties.find((x) => x.side === 1 && x.role === "player")?.shareBps ?? 0 } : null,
  ];
  const seat = mine === sides[0].player ? 0 : mine && mine === sides[1]?.player ? 1 : null;
  const backerSeat = mine ? ([0, 1] as const).find((i) => sides[i] && sides[i].funder === mine && sides[i].player !== mine) ?? null : null;
  const backedSeat = seat !== null && sides[seat]?.funder !== sides[seat]?.player ? seat : backerSeat;
  const backedSide = backedSeat === null ? null : sides[backedSeat];
  const draw = p.winnerSide === null && p.kind === 2;
  const settled = p.status === "settled";
  return {
    id: p.id,
    opener: key.opener,
    n: key.n,
    game,
    address: matchPda(new PublicKey(key.opener), key.n),
    status: settled ? "settled" : p.status === "refunded" ? "refunded" : p.status === "seen" ? "active" : "active",
    running: p.status === "settling" ? "settling" : p.status === "refunding" ? "refunding" : null,
    entry: p.entry,
    seat,
    opponent: seat === 0 ? (sides[1]?.player ?? null) : seat === 1 ? sides[0].player : null,
    deadline: 0,
    openedAt: p.openedAt,
    challenge: p.challenge,
    asset: p.asset,
    sides,
    backerSeat,
    backing: backedSeat !== null && backedSide ? { seat: backedSeat, player: backedSide.player, funder: backedSide.funder, shareBps: backedSide.shareBps } : null,
    fees: { platformBps: 0, studioBps: 0, leaderboardBps: 0 },
    winner: p.winnerSide === 0 ? "opener" : p.winnerSide === 1 ? "joiner" : null,
    session: p.scores
      ? { settled: settled || draw, joined: true, result: p.winnerSide === 0 ? "opener" : p.winnerSide === 1 ? "joiner" : "draw", scores: p.scores, seed: 0n, openerDeadline: 0, deadline: 0 }
      : null,
  };
}

/** A finished Vanguard Battle on the base layer (committed back by `close_match`); its `winner` is the winning seat. */
async function battleOnBase(match: PublicKey): Promise<{ winner: number } | null> {
  const info = await getChain().base.getAccountInfo(battleOf(match)).catch(() => null);
  if (!info || !info.owner.equals(VANGUARD_PROGRAM_ID)) return null;
  try {
    return decodeBattle(info.data);
  } catch {
    return null;
  }
}

/** A finished Hold'em table on the base layer (committed back by `close_match`). */
async function holdemTable(match: PublicKey): Promise<any | null> {
  const acc = getHoldem().program.account as Record<string, any>;
  return (await acc.gameMatch.fetchNullable(holdemTableOf(match)).catch(() => null)) ?? null;
}

/** A finished Trading Duel on the base layer (committed back by `close_match`). */
async function duelAccount(match: PublicKey): Promise<any | null> {
  const acc = getTradingDuel().program.account as Record<string, any>;
  return (await acc.duel.fetchNullable(duelOf(match)).catch(() => null)) ?? null;
}

/** Fetches and decodes many accounts; one that is missing or fails to decode (a Session from an older program layout) is null, not an error. */
export async function decodeAll(keys: PublicKey[], decode: (data: Buffer) => any): Promise<any[]> {
  return (await accountInfos(keys)).map((info) => (info ? decodeOr(info.data, decode) : null));
}

/** Raw accounts in key order, 100 keys per request (the getMultipleAccounts limit), requests in parallel. */
async function accountInfos(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  return (await Promise.all(chunks.map((c) => getChain().base.getMultipleAccountsInfo(c)))).flat();
}

function decodeOr(data: Buffer, decode: (data: Buffer) => any): any {
  try {
    return decode(data);
  } catch {
    return null;
  }
}

/** Sessions and tables of finished Matches, by Match key: they never change again, so each is read once per tab. */
const finished = new Map<string, any>();

async function gameAccounts(rows: any[], address: (match: PublicKey) => PublicKey, decode: (data: Buffer) => any): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const unread = rows.filter((m) => {
    const id = matchKeyOfState(m.account);
    const hit = finished.get(id);
    if (hit) out.set(id, hit);
    return !hit;
  });
  const read = await decodeAll(unread.map((m) => address(m.publicKey)), decode);
  unread.forEach((m, i) => {
    const id = matchKeyOfState(m.account);
    const stage = enumKey(m.account.inner.stage);
    out.set(id, read[i]);
    if (read[i] && stage === "closed") finished.set(id, read[i]);
  });
  return out;
}

/** Every MatchState the program holds, decoded. Closed Matches are gone from here: their record is the history. */
async function allMatchStates(): Promise<{ publicKey: PublicKey; account: any }[]> {
  return (await getChain().core.account.matchState.all()) as { publicKey: PublicKey; account: any }[];
}

const involves = (inner: any, key: PublicKey) => [inner.a, inner.b].filter(Boolean).some((s: any) => pk(s.player).equals(key) || (pk(s.funder).equals(key) && !pk(s.player).equals(key)));

/**
 * The live Matches of an Account (Open, Active, Settling, Refunding, awaiting close), played and funded,
 * newest first. `key` is the TesoroAccount key: seats and the Backing are relative to it. Finished Matches
 * are history: read them with `fetchHistoryPage`.
 */
export async function fetchAccountMatches(key: PublicKey): Promise<{ played: ChainMatch[]; funded: ChainMatch[] }> {
  const chain = getChain();
  const [, all] = await Promise.all([fetchLeaderboardTerms(chain.core.provider.connection).catch(() => undefined), allMatchStates()]);
  const mine = all.filter((m) => gameOf(pk(m.account.inner.game)) !== null && involves(m.account.inner, key));
  const isGame = (g: GameId) => (m: any) => gameOf(pk(m.account.inner.game)) === g;
  const closed = (m: any) => ["closed", "settling", "refunding"].includes(enumKey(m.account.inner.stage));
  const holdem = getHoldem().program;
  const duelProgram = getTradingDuel().program;
  const [sessions, tables, duels, battles] = await Promise.all([
    gameAccounts(
      mine.filter((m) => isGame("block-puzzle")(m)),
      sessionOf,
      (data) => chain.bp.coder.accounts.decode("session", data),
    ),
    gameAccounts(
      mine.filter((m) => isGame("holdem")(m) && closed(m)),
      holdemTableOf,
      (data) => holdem.coder.accounts.decode("gameMatch", data),
    ),
    gameAccounts(
      mine.filter((m) => isGame("trading-duel")(m) && closed(m)),
      duelOf,
      (data) => duelProgram.coder.accounts.decode("duel", data),
    ),
    gameAccounts(
      mine.filter((m) => isGame("vanguard")(m) && closed(m)),
      battleOf,
      (data) => decodeBattle(data),
    ),
  ]);
  const all_ = mine
    .map((m) => {
      const id = matchKeyOfState(m.account);
      return toChainMatch(m.account, key, sessions.get(id) ?? null, tables.get(id) ?? duels.get(id) ?? battles.get(id) ?? null);
    })
    .sort((x, y) => y.openedAt - x.openedAt);
  return { played: all_.filter((m) => m.seat !== null), funded: all_.filter((m) => m.seat === null && m.backerSeat !== null) };
}

/** Whether a TesoroAccount exists at this address (false for any other kind of account). */
export async function accountExists(key: PublicKey): Promise<boolean> {
  try {
    return (await getChain().core.account.tesoroAccount.fetchNullable(key)) !== null;
  } catch {
    return false;
  }
}

/**
 * Open Queue Matches at this entry that `me`, paid for by `funder` (a Backer, or `me`), may join, oldest first
 * (Challenges are excluded). A list read that may lag the chain: re-read a Match before acting on it. A Match is
 * joinable unless the core rule refuses it: nobody joins a Match whose seat they fund (`SelfMatch`).
 */
export async function listQueueMatchIds(entry: number, me: PublicKey, game: GameId = "block-puzzle", asset?: number, funder: PublicKey = me): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const all = await allMatchStates();
  return all
    .filter((m) => {
      const inner = m.account.inner;
      return (
        enumKey(inner.stage) === "open" &&
        gameOf(pk(inner.game)) === game &&
        Number(inner.entry.toString()) === entry &&
        !inner.meta.challenge &&
        (asset === undefined || game !== "trading-duel" || inner.meta.asset === asset) &&
        seatsCanPair({ player: pk(inner.a.player).toBase58(), funder: pk(inner.a.funder).toBase58() }, { player: me.toBase58(), funder: funder.toBase58() }) &&
        Number(inner.deadline.toString()) > now + 60
      );
    })
    .sort((x, y) => Number(big(x.account.inner.openedAt) - big(y.account.inner.openedAt)) || (matchKeyOfState(x.account) < matchKeyOfState(y.account) ? -1 : 1))
    .map((m) => matchKeyOfState(m.account));
}

/**
 * Whether `me` may take the other seat of a Match whose opening side is `a` (`{ player, funder }` as bytes):
 * not their own Match, and not one they fund (tesoro_core refuses a Backer joining the Player they back).
 */
export function canJoinSeat(a: { player: number[] | Uint8Array; funder: number[] | Uint8Array }, me: PublicKey): boolean {
  return !pk(a.player).equals(me) && !pk(a.funder).equals(me);
}

/** Open or Active Matches of one Game this Account plays, newest first. A list read that may lag the chain. */
export async function listLiveMatchIds(me: PublicKey, game: GameId): Promise<string[]> {
  const all = await allMatchStates();
  return all
    .filter((m) => {
      const inner = m.account.inner;
      const stage = enumKey(inner.stage);
      return (stage === "open" || stage === "active") && gameOf(pk(inner.game)) === game && [inner.a, inner.b].some((s: any) => s && pk(s.player).equals(me));
    })
    .sort((x, y) => Number(big(y.account.inner.openedAt) - big(x.account.inner.openedAt)))
    .map((m) => matchKeyOfState(m.account));
}

export interface QueueSeat {
  /** Account key of the Player waiting. */
  player: string;
  /** Account key that paid the entry: the Player, or their Backer. */
  funder: string;
  entry: number;
  /** TesoroAccount key of whoever put the Gemas in (differs from `player` when the seat is backed). */
  funder?: string;
  /** Trading Duel asset index; 0 for the other Games. */
  asset: number;
}

/** Open Queue Matches per Game, oldest first: who waits and at which entry (for the Lobby). One list read. `me` hides seats the viewer may not join. */
export async function queueSeats(): Promise<Record<GameId, QueueSeat[]>> {
  const now = Math.floor(Date.now() / 1000);
  const all = await allMatchStates();
  const out: Record<GameId, (QueueSeat & { at: number })[]> = { "block-puzzle": [], holdem: [], "trading-duel": [], vanguard: [] };
  for (const m of all) {
    const inner = m.account.inner;
    const game = gameOf(pk(inner.game));
    if (!game || enumKey(inner.stage) !== "open" || inner.meta.challenge || Number(inner.deadline.toString()) <= now) continue;
    out[game].push({
      player: pk(inner.a.player).toBase58(),
      funder: pk(inner.a.funder).toBase58(),
      entry: Number(inner.entry.toString()),
      asset: game === "trading-duel" ? inner.meta.asset : 0,
      at: Number(big(inner.openedAt)),
    });
  }
  const sorted = (seats: (QueueSeat & { at: number })[]) => seats.sort((x, y) => x.at - y.at).map(({ player, funder, entry, asset }) => ({ player, funder, entry, asset }));
  return { "block-puzzle": sorted(out["block-puzzle"]), holdem: sorted(out.holdem), "trading-duel": sorted(out["trading-duel"]), vanguard: sorted(out.vanguard) };
}

/** The full Account: its state, then its Matches. `onAccount` gets the state first, so Gemas show before the Match list is read. */
export async function fetchSnapshot(authority: PublicKey, onAccount?: (s: AccountSnapshot) => void, opts: { fresh?: boolean } = {}): Promise<AccountSnapshot> {
  const matches = fetchAccountMatches(BlockPuzzleChain.coreAccount(authority));
  matches.catch(() => undefined);
  const snap = await fetchAccountState(authority, opts);
  if (!snap.exists) return { ...snap, matchesLoaded: true };
  onAccount?.(snap);
  const { played, funded } = await matches;
  return { ...snap, matches: played, funded, matchesLoaded: true };
}

/** The Positions of one owner, current layout only: an old, shorter account is skipped instead of failing the read. */
async function ownedPositions(chain: ReturnType<typeof getChain>, owner: PublicKey) {
  const rows = await chain.base.getProgramAccounts(chain.core.programId, {
    filters: [{ memcmp: chain.core.coder.accounts.memcmp("positionState") }, { memcmp: { offset: 41, bytes: owner.toBase58() } }],
  });
  return rows
    .filter((r) => isCurrentPosition(r.account.data))
    .map((r) => ({ publicKey: r.pubkey, account: chain.core.coder.accounts.decode("positionState", r.account.data) }));
}

/** The overflow records of one Account: Gemas that found no room in its stores. A failed read answers none (the Wallet just shows nothing waiting). */
async function ownedOverflow(chain: ReturnType<typeof getChain>, owner: PublicKey): Promise<WaitingRecord[]> {
  const rows = await chain.base.getProgramAccounts(chain.core.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(OVERFLOW_DISC) } }, { memcmp: { offset: OVERFLOW_OWNER_AT, bytes: owner.toBase58() } }],
  });
  return rows.flatMap((r) => decodeOverflowRecord(r.pubkey, r.account.data) ?? []);
}

/**
 * The Account without its Matches (`matchesLoaded` false): SOL, Gemas, Positions and the simSOL market.
 * Asks the server route first (one request; see server/snapshot.ts) and reads the chain itself when it
 * fails or is slow. `fresh`: this tab just sent a transaction, so the server re-reads its lists first.
 */
export async function fetchAccountState(authority: PublicKey, opts: { fresh?: boolean } = {}): Promise<AccountSnapshot> {
  const routed = await fetchRoutedState(authority, opts);
  if (routed) return routed;
  const chain = getChain();
  return readAccountState(
    {
      // PositionState: disc 8 + bump 1 + position_id 32, then `inner.owner`.
      lists: (key) => ownedPositions(chain, key),
      overflow: (key) => ownedOverflow(chain, key),
      infos: (keys) => chain.base.getMultipleAccountsInfo(keys),
      balance: (a) => chain.base.getBalance(a),
      decode: (name, data) => chain.core.coder.accounts.decode(name, data),
    },
    authority,
    BlockPuzzleChain.coreAccount(authority),
  );
}
