import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID, addresses as holdemAddresses } from "@/games/holdem/chain";
import { TRADING_DUEL_PROGRAM_ID, addresses as duelAddresses } from "@/games/trading-duel/chain";
import type { GameId } from "@/lib/mock/types";
import { getChain, getHoldem, getTradingDuel } from "./client";
import { assetIndexOf, matchOpenedAt } from "./match-id";
import { canJoinSeat } from "./queue";
import { fetchLeaderboardTerms } from "./leaderboard";
import { leaderboardBpsFor } from "./season";
import { readAccountState } from "./account-state";
import { isCurrentPosition } from "./position-size";
import { fetchRoutedState } from "./snapshot-wire";
import type { NativeInfo, NativeMarket } from "./native";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());

export type MatchStatus = "open" | "active" | "settled" | "refunded";

/** A Match as one Account sees it (the signed-in one, or the Account a page is about). */
export interface ChainMatch {
  id: bigint;
  game: GameId;
  address: PublicKey;
  status: MatchStatus;
  entry: number;
  /** Which side of the Match this Account is on, null when not a participant. */
  seat: 0 | 1 | null;
  /** TesoroAccount key of the opponent, null until one joins. */
  opponent: string | null;
  /** Unix seconds after which anyone may refund an unfinished Match. */
  deadline: number;
  /** Challenge Matches have an odd id (see match-flow.ts). */
  challenge: boolean;
  /** Who plays and who funds each entry; they differ on a backed side. */
  sides: [MatchSide, MatchSide | null];
  /** Seat this Account funds without playing (it is the Backer), else null. */
  backerSeat: 0 | 1 | null;
  /** The Backing this Account is part of in this Match (as the backed Player or as the Backer), else null. */
  backing: { seat: 0 | 1; player: string; funder: string; shareBps: number } | null;
  fees: { platformBps: number; studioBps: number; leaderboardBps: number };
  /** Hold'em: the winning seat of a settled table (null for a refund or while unsettled). */
  winner: "opener" | "joiner" | null;
  /** Block Puzzle: set as soon as the Match is opened (the opener plays before anyone is paired). */
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

export interface ChainHolding {
  holding: PublicKey;
  source: PublicKey;
  position: PublicKey;
  isOwn: boolean;
  amount: bigint;
  reserved: bigint;
  free: bigint;
  /** Free Gemas of this holding that Redeem would pay now. */
  redeemable: bigint;
  /** Won Gemas Redeem now can sell: what is still waiting on yield once `redeemable` is redeemed in full (Solana-native Sources)
   * or as they stand (ETH, HYPE). 0 for own Gemas. */
  pending: bigint;
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
  holdings: ChainHolding[];
  positions: ChainPosition[];
  matches: ChainMatch[];
  /** sim_lst pool, price feed and simSOL balance (SIMULATED yield). Null until read. */
  market: NativeMarket | null;
  /** Matches this Account funded as a Backer without playing them. */
  funded: ChainMatch[];
  /** False while `matches` and `funded` are not read yet (they arrive after the rest of the Account). */
  matchesLoaded: boolean;
  fetchedAt: number;
}

const enumKey = (o: object) => Object.keys(o)[0];
const isChallengeId = (id: bigint) => (id & 1n) === 1n;

/** The Game a tesoro_core Match belongs to, or null for a program this app does not play. */
export function gameOf(game: PublicKey): GameId | null {
  if (game.equals(BLOCK_PUZZLE_PROGRAM_ID)) return "block-puzzle";
  if (game.equals(HOLDEM_PROGRAM_ID)) return "holdem";
  if (game.equals(TRADING_DUEL_PROGRAM_ID)) return "trading-duel";
  return null;
}

export function toChainMatch(state: any, me: PublicKey | null, session: any | null, table: any | null = null): ChainMatch {
  const m = state.inner;
  const a = pk(m.a.player).toBase58();
  const b = m.b ? pk(m.b.player).toBase58() : null;
  const mine = me?.toBase58();
  const seat = mine === a ? 0 : mine && mine === b ? 1 : null;
  const id = big(state.id);
  const status = enumKey(m.status).toLowerCase() as MatchStatus;
  const side = (s: any): MatchSide => ({ player: pk(s.player).toBase58(), funder: pk(s.funder).toBase58(), shareBps: s.shareBps });
  const sides: [MatchSide, MatchSide | null] = [side(m.a), m.b ? side(m.b) : null];
  const backerSeat = mine ? ([0, 1] as const).find((i) => sides[i] && sides[i].funder === mine && sides[i].player !== mine) ?? null : null;
  const backedSeat = seat !== null && sides[seat]?.funder !== sides[seat]?.player ? seat : backerSeat;
  const backedSide = backedSeat === null ? null : sides[backedSeat];
  return {
    id,
    game: gameOf(pk(m.game)) ?? "block-puzzle",
    address: BlockPuzzleChain.addresses(id).match,
    status,
    entry: Number(m.entry.toString()),
    seat,
    opponent: seat === 0 ? b : seat === 1 ? a : null,
    deadline: Number(m.deadline.toString()),
    challenge: isChallengeId(id),
    sides,
    backerSeat,
    backing:
      backedSeat !== null && backedSide
        ? { seat: backedSeat, player: backedSide.player, funder: backedSide.funder, shareBps: backedSide.shareBps }
        : null,
    fees: { platformBps: m.fees.platformBps, studioBps: m.fees.studioBps, leaderboardBps: leaderboardBpsFor(matchOpenedAt(id, gameOf(pk(m.game)))) },
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

/** Reads one Match (and its Session, when it has one). Null when the Match does not exist. */
export async function fetchMatch(id: bigint, me: PublicKey | null): Promise<ChainMatch | null> {
  const chain = getChain();
  await fetchLeaderboardTerms(chain.core.provider.connection).catch(() => undefined);
  const a = BlockPuzzleChain.addresses(id);
  const state = await chain.core.account.matchState.fetchNullable(a.match);
  if (!state) return null;
  if (gameOf(pk(state.inner.game)) === "holdem") {
    const table = enumKey(state.inner.status) === "settled" ? await holdemTable(id) : null;
    return toChainMatch(state, me, null, table);
  }
  if (gameOf(pk(state.inner.game)) === "trading-duel") {
    const duel = enumKey(state.inner.status) === "settled" ? await duelAccount(id) : null;
    return toChainMatch(state, me, null, duel);
  }
  const session = await chain.bp.account.session.fetchNullable(a.session).catch(() => null);
  return toChainMatch(state, me, session);
}

/** A finished Hold'em table on the base layer (committed back by `close_match`). */
async function holdemTable(id: bigint): Promise<any | null> {
  const acc = getHoldem().program.account as Record<string, any>;
  return (await acc.gameMatch.fetchNullable(holdemAddresses(id).gameMatch).catch(() => null)) ?? null;
}

/** A finished Trading Duel on the base layer (committed back by `close_match`). */
async function duelAccount(id: bigint): Promise<any | null> {
  const acc = getTradingDuel().program.account as Record<string, any>;
  return (await acc.duel.fetchNullable(duelAddresses(id).duel).catch(() => null)) ?? null;
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

/** Sessions and Hold'em tables of finished Matches, by Match id: they never change again, so each is read once per tab. */
const finished = new Map<string, any>();

async function gameAccounts(rows: any[], address: (id: bigint) => PublicKey, decode: (data: Buffer) => any): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const unread = rows.filter((m) => {
    const id = big(m.account.id).toString();
    const hit = finished.get(id);
    if (hit) out.set(id, hit);
    return !hit;
  });
  const read = await decodeAll(unread.map((m) => address(big(m.account.id))), decode);
  unread.forEach((m, i) => {
    const id = big(m.account.id).toString();
    const status = enumKey(m.account.inner.status);
    out.set(id, read[i]);
    if (read[i] && (status === "settled" || status === "refunded")) finished.set(id, read[i]);
  });
  return out;
}

/**
 * Every Match an Account plays, and every Match it funds as a Backer, newest first. `key` is the
 * TesoroAccount key (any Account, not only the signed-in one): seats and the Backing are relative to it.
 */
export async function fetchAccountMatches(key: PublicKey): Promise<{ played: ChainMatch[]; funded: ChainMatch[] }> {
  const chain = getChain();
  const [, all] = await Promise.all([fetchLeaderboardTerms(chain.core.provider.connection).catch(() => undefined), chain.core.account.matchState.all()]);
  const mine = all.filter((m: any) => {
    const inner = m.account.inner;
    const sides = [inner.a, inner.b].filter(Boolean);
    const involved = sides.some((s: any) => pk(s.player).equals(key) || (pk(s.funder).equals(key) && !pk(s.player).equals(key)));
    return gameOf(pk(inner.game)) !== null && involved;
  });
  const isGame = (g: GameId) => (m: any) => gameOf(pk(m.account.inner.game)) === g;
  const isHoldem = isGame("holdem");
  const isDuel = isGame("trading-duel");
  const settled = (m: any) => enumKey(m.account.inner.status) === "settled";
  const holdem = getHoldem().program;
  const duelProgram = getTradingDuel().program;
  const [sessions, tables, duels] = await Promise.all([
    gameAccounts(
      mine.filter((m: any) => !isHoldem(m) && !isDuel(m)),
      (id) => BlockPuzzleChain.addresses(id).session,
      (data) => chain.bp.coder.accounts.decode("session", data),
    ),
    gameAccounts(
      mine.filter((m: any) => isHoldem(m) && settled(m)),
      (id) => holdemAddresses(id).gameMatch,
      (data) => holdem.coder.accounts.decode("gameMatch", data),
    ),
    gameAccounts(
      mine.filter((m: any) => isDuel(m) && settled(m)),
      (id) => duelAddresses(id).duel,
      (data) => duelProgram.coder.accounts.decode("duel", data),
    ),
  ]);
  const all_ = mine
    .map((m: any) => {
      const id = big(m.account.id).toString();
      return toChainMatch(m.account, key, sessions.get(id) ?? null, tables.get(id) ?? duels.get(id) ?? null);
    })
    .sort((x: ChainMatch, y: ChainMatch) => (x.id < y.id ? 1 : -1));
  return { played: all_.filter((m: ChainMatch) => m.seat !== null), funded: all_.filter((m: ChainMatch) => m.seat === null && m.backerSeat !== null) };
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
 * (Challenges are excluded). A list read that may lag the chain: re-read a Match before acting on it.
 */
export async function listQueueMatchIds(entry: number, me: PublicKey, game: GameId = "block-puzzle", asset?: number, funder: PublicKey = me): Promise<bigint[]> {
  const chain = getChain();
  const now = Math.floor(Date.now() / 1000);
  const all = await chain.core.account.matchState.all();
  return all
    .filter((m: any) => {
      const inner = m.account.inner;
      return (
        enumKey(inner.status) === "open" &&
        gameOf(pk(inner.game)) === game &&
        Number(inner.entry.toString()) === entry &&
        !isChallengeId(big(m.account.id)) &&
        (asset === undefined || game !== "trading-duel" || assetIndexOf(big(m.account.id)) === asset) &&
        canJoinSeat({ player: pk(inner.a.player).toBase58(), funder: pk(inner.a.funder).toBase58() }, { player: me.toBase58(), funder: funder.toBase58() }) &&
        Number(inner.deadline.toString()) > now + 60
      );
    })
    .map((m: any) => big(m.account.id))
    .sort((x: bigint, y: bigint) => (x < y ? -1 : 1));
}

/** Open or Active Matches of one Game this Account plays, newest first. A list read that may lag the chain. */
export async function listLiveMatchIds(me: PublicKey, game: GameId): Promise<bigint[]> {
  const all = await getChain().core.account.matchState.all();
  return all
    .filter((m: any) => {
      const inner = m.account.inner;
      const status = enumKey(inner.status);
      return (
        (status === "open" || status === "active") &&
        gameOf(pk(inner.game)) === game &&
        [inner.a, inner.b].some((s: any) => s && pk(s.player).equals(me))
      );
    })
    .map((m: any) => big(m.account.id))
    .sort((x: bigint, y: bigint) => (x < y ? 1 : -1));
}

export interface QueueSeat {
  /** Account key of the Player waiting. */
  player: string;
  /** Account key that paid the entry: the Player, or their Backer. */
  funder: string;
  entry: number;
  /** Trading Duel asset index; 0 for the other Games. */
  asset: number;
}

/** Open Queue Matches per Game, oldest first: who waits and at which entry (for the Lobby). One list read. */
export async function queueSeats(): Promise<Record<GameId, QueueSeat[]>> {
  const now = Math.floor(Date.now() / 1000);
  const all = await getChain().core.account.matchState.all();
  const out: Record<GameId, (QueueSeat & { id: bigint })[]> = { "block-puzzle": [], holdem: [], "trading-duel": [] };
  for (const m of all as any[]) {
    const inner = m.account.inner;
    const id = big(m.account.id);
    const game = gameOf(pk(inner.game));
    if (!game || enumKey(inner.status) !== "open" || isChallengeId(id) || Number(inner.deadline.toString()) <= now) continue;
    out[game].push({ id, player: pk(inner.a.player).toBase58(), funder: pk(inner.a.funder).toBase58(), entry: Number(inner.entry.toString()), asset: game === "trading-duel" ? assetIndexOf(id) : 0 });
  }
  const sorted = (seats: (QueueSeat & { id: bigint })[]) => seats.sort((x, y) => (x.id < y.id ? -1 : 1)).map(({ player, funder, entry, asset }) => ({ player, funder, entry, asset }));
  return { "block-puzzle": sorted(out["block-puzzle"]), holdem: sorted(out.holdem), "trading-duel": sorted(out["trading-duel"]) };
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
      lists: (key) =>
        Promise.all([
          chain.core.account.holdingState.all([{ memcmp: { offset: 9, bytes: key.toBase58() } }]),
          // PositionState: disc 8 + bump 1 + position_id 32, then `inner.owner`.
          ownedPositions(chain, key),
        ]),
      infos: (keys) => chain.base.getMultipleAccountsInfo(keys),
      balance: (a) => chain.base.getBalance(a),
      decode: (name, data) => chain.core.coder.accounts.decode(name, data),
    },
    authority,
    BlockPuzzleChain.coreAccount(authority),
  );
}
