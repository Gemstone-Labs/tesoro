import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, TESORO_CORE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID, addresses as holdemAddresses } from "@/games/holdem/chain";
import type { GameId } from "@/lib/mock/types";
import { getChain, getHoldem } from "./client";
import { debtGemas, debtUnits, redeemableFor, type SourceMath } from "./ledger";
import { parseEthPositionId } from "./eth";
import { SIM_SOL_MINT, fetchNativeInfo, fetchNativeMarket, type NativeInfo, type NativeMarket } from "./native";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());

export type MatchStatus = "open" | "active" | "settled" | "refunded";

/** A Match as the signed-in Account sees it. */
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
  fees: { platformBps: number; studioBps: number };
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
  /** Owner Account key of the Source's Position. */
  sourceOwner: string;
  asset: "SOL" | "ETH" | "HYPE";
  /** The Source's Position holds simSOL custody: Redeem pays simSOL on Solana. */
  native: boolean;
  /** The Source belongs to an Ethereum Position (Redeem pays on Hoodi through the bridge). */
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
  advance: ChainAdvance | null;
  /** Debt in asset units. */
  debt: number;
  yieldAccrued: number;
  /** simSOL custody details, for Solana-native Positions. */
  native: NativeInfo | null;
  /** Ethereum Position: the Hoodi vault and its position id. */
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
  fetchedAt: number;
}

const ASSETS = ["SOL", "ETH", "HYPE"] as const;
const enumKey = (o: object) => Object.keys(o)[0];
const isChallengeId = (id: bigint) => (id & 1n) === 1n;

/** The Game a tesoro_core Match belongs to, or null for a program this app does not play. */
export function gameOf(game: PublicKey): GameId | null {
  if (game.equals(BLOCK_PUZZLE_PROGRAM_ID)) return "block-puzzle";
  if (game.equals(HOLDEM_PROGRAM_ID)) return "holdem";
  return null;
}

function sourceMath(inner: any): SourceMath {
  return {
    issued: big(inner.issued),
    returned: big(inner.returned),
    redeemed: big(inner.redeemed),
    yieldUnits: big(inner.yieldUnits),
    unitNum: big(inner.unitNum),
    unitDen: big(inner.unitDen),
  };
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
    fees: { platformBps: m.fees.platformBps, studioBps: m.fees.studioBps },
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
  const a = BlockPuzzleChain.addresses(id);
  const state = await chain.core.account.matchState.fetchNullable(a.match);
  if (!state) return null;
  if (gameOf(pk(state.inner.game)) === "holdem") {
    const table = enumKey(state.inner.status) === "settled" ? await holdemTable(id) : null;
    return toChainMatch(state, me, null, table);
  }
  const session = await chain.bp.account.session.fetchNullable(a.session).catch(() => null);
  return toChainMatch(state, me, session);
}

/** A finished Hold'em table on the base layer (committed back by `close_match`). */
async function holdemTable(id: bigint): Promise<any | null> {
  const acc = getHoldem().program.account as Record<string, any>;
  return (await acc.gameMatch.fetchNullable(holdemAddresses(id).gameMatch).catch(() => null)) ?? null;
}

/** Every Match this Account plays, and every Match it funds as a Backer, newest first. */
async function fetchMyMatches(me: PublicKey): Promise<{ played: ChainMatch[]; funded: ChainMatch[] }> {
  const chain = getChain();
  const all = await chain.core.account.matchState.all();
  const mine = all.filter((m: any) => {
    const inner = m.account.inner;
    const sides = [inner.a, inner.b].filter(Boolean);
    const involved = sides.some((s: any) => pk(s.player).equals(me) || (pk(s.funder).equals(me) && !pk(s.player).equals(me)));
    return gameOf(pk(inner.game)) !== null && involved;
  });
  const isHoldem = (m: any) => gameOf(pk(m.account.inner.game)) === "holdem";
  const bpRows = mine.filter((m: any) => !isHoldem(m));
  const sessionKeys = bpRows.map((m: any) => BlockPuzzleChain.addresses(big(m.account.id)).session);
  const sessions = sessionKeys.length ? await chain.bp.account.session.fetchMultiple(sessionKeys) : [];
  const sessionOf = new Map<string, any>(bpRows.map((m: any, i: number) => [big(m.account.id).toString(), sessions[i] ?? null]));
  const tables = new Map<string, any>();
  await Promise.all(
    mine
      .filter((m: any) => isHoldem(m) && enumKey(m.account.inner.status) === "settled")
      .map(async (m: any) => tables.set(big(m.account.id).toString(), await holdemTable(big(m.account.id)))),
  );
  const all_ = mine
    .map((m: any) => {
      const key = big(m.account.id).toString();
      return toChainMatch(m.account, me, sessionOf.get(key) ?? null, tables.get(key) ?? null);
    })
    .sort((x: ChainMatch, y: ChainMatch) => (x.id < y.id ? 1 : -1));
  return { played: all_.filter((m: ChainMatch) => m.seat !== null), funded: all_.filter((m: ChainMatch) => m.seat === null && m.backerSeat !== null) };
}

/** The oldest Open Queue Match at this entry from another Account, if any (Challenges are excluded). */
export async function findQueueMatch(entry: number, me: PublicKey, game: GameId = "block-puzzle"): Promise<bigint | null> {
  const chain = getChain();
  const now = Math.floor(Date.now() / 1000);
  const all = await chain.core.account.matchState.all();
  const open = all
    .filter((m: any) => {
      const inner = m.account.inner;
      return (
        enumKey(inner.status) === "open" &&
        gameOf(pk(inner.game)) === game &&
        Number(inner.entry.toString()) === entry &&
        !isChallengeId(big(m.account.id)) &&
        !pk(inner.a.player).equals(me) &&
        Number(inner.deadline.toString()) > now + 60
      );
    })
    .map((m: any) => big(m.account.id))
    .sort((x: bigint, y: bigint) => (x < y ? -1 : 1));
  // Only Matches whose opener has a Session (opened by this version of the app) can be joined.
  const sessions = open.length ? await chain.bp.account.session.fetchMultiple(open.map((id: bigint) => BlockPuzzleChain.addresses(id).session)) : [];
  const idx = open.findIndex((_id: bigint, i: number) => sessions[i]);
  return idx >= 0 ? open[idx] : null;
}

/** Number of Open Queue Matches for one Game (for the Lobby). */
export async function queueDepth(game: GameId = "block-puzzle"): Promise<number> {
  const chain = getChain();
  const now = Math.floor(Date.now() / 1000);
  const all = await chain.core.account.matchState.all();
  return all.filter((m: any) => {
    const inner = m.account.inner;
    return enumKey(inner.status) === "open" && gameOf(pk(inner.game)) === game && !isChallengeId(big(m.account.id)) && Number(inner.deadline.toString()) > now;
  }).length;
}

export async function fetchSnapshot(authority: PublicKey): Promise<AccountSnapshot> {
  const chain = getChain();
  const accountKey = BlockPuzzleChain.coreAccount(authority);
  const [acct, lamports] = await Promise.all([
    chain.core.account.tesoroAccount.fetchNullable(accountKey),
    chain.base.getBalance(authority).catch(() => 0),
  ]);
  const empty: AccountSnapshot = {
    exists: false,
    accountKey,
    lamports,
    ownTotal: 0n,
    wonTotal: 0n,
    holdings: [],
    positions: [],
    matches: [],
    market: null,
    funded: [],
    fetchedAt: Date.now(),
  };
  const market = await fetchNativeMarket(chain.base, authority).catch((e) => {
    console.warn("native market", e);
    return null;
  });
  empty.market = market;
  if (!acct) return empty;

  const [holdingRows, positionRows, { played: matches, funded }] = await Promise.all([
    chain.core.account.holdingState.all([{ memcmp: { offset: 9, bytes: accountKey.toBase58() } }]),
    // PositionState: disc 8 + bump 1 + position_id 32, then `inner.owner`.
    chain.core.account.positionState.all([{ memcmp: { offset: 41, bytes: accountKey.toBase58() } }]),
    fetchMyMatches(accountKey),
  ]);

  const heldSources = holdingRows.map((h: any) => pk(h.account.inner.source));
  const ownedPositions = positionRows.map((p: any) => p.publicKey as PublicKey);
  const sources = heldSources.length ? await chain.core.account.sourceState.fetchMultiple(heldSources) : [];
  const positionKeys = new Map<string, PublicKey>();
  for (const s of sources) if (s) positionKeys.set(pk((s as any).inner.position).toBase58(), pk((s as any).inner.position));
  for (const p of ownedPositions) positionKeys.set(p.toBase58(), p);
  const heldPositions = await chain.core.account.positionState.fetchMultiple([...positionKeys.values()]);
  const positionByKey = new Map<string, any>([...positionKeys.keys()].map((k, i) => [k, heldPositions[i]]));

  const isNativePosition = (pos: any) => !!pos && pk(pos.inner.sourceAsset).equals(SIM_SOL_MINT) && enumKey(pos.inner.sourceChain) === "solana";
  const nativeInfo = new Map<string, NativeInfo | null>();
  await Promise.all(
    [...positionByKey.entries()]
      .filter(([, pos]) => isNativePosition(pos))
      .map(async ([k]) => nativeInfo.set(k, await fetchNativeInfo(chain.base, new PublicKey(k)).catch(() => null))),
  );

  const holdings: ChainHolding[] = [];
  holdingRows.forEach((row: any, i: number) => {
    const src: any = sources[i];
    if (!src) return;
    const h = row.account.inner;
    const amount = big(h.amount);
    const reserved = big(h.reserved);
    const free = amount - reserved;
    const pos = positionByKey.get(pk(src.inner.position).toBase58());
    holdings.push({
      holding: row.publicKey,
      source: heldSources[i],
      position: pk(src.inner.position),
      isOwn: h.isOwn,
      amount,
      reserved,
      free,
      redeemable: redeemableFor(sourceMath(src.inner), free),
      sourceOwner: pk(src.inner.owner).toBase58(),
      native: !!nativeInfo.get(pk(src.inner.position).toBase58()),
      eth: pos && enumKey(pos.inner.sourceChain) === "ethereum" ? parseEthPositionId(Uint8Array.from(pos.positionId)) : null,
      asset: ASSETS[pos ? ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(pos.inner.sourceChain)) : 0] ?? "SOL",
    });
  });

  const positions: ChainPosition[] = [];
  for (const row of positionRows as any[]) {
    const p = row.account.inner;
    const chainIdx = ["solana", "ethereum", "hyperEvm"].indexOf(enumKey(p.sourceChain));
    const decimals = 10 ** p.decimals;
    let advance: ChainAdvance | null = null;
    let debt = 0;
    if (p.openAdvance !== null && p.openAdvance !== undefined) {
      const sourceKey = PublicKey.findProgramAddressSync(
        [Buffer.from("source"), (row.publicKey as PublicKey).toBuffer(), new BN(p.openAdvance).toArrayLike(Buffer, "le", 4)],
        TESORO_CORE_PROGRAM_ID,
      )[0];
      const src: any = await chain.core.account.sourceState.fetchNullable(sourceKey);
      if (src) {
        const m = sourceMath(src.inner);
        advance = {
          source: sourceKey,
          gemasIssued: Number(m.issued),
          horizonMonths: src.inner.horizonMonths,
          debtGemas: Number(debtGemas(m)),
        };
        debt = Number(debtUnits(m)) / decimals;
      }
    }
    positions.push({
      address: row.publicKey,
      asset: ASSETS[chainIdx] ?? "SOL",
      principal: Number(big(p.principal)) / decimals,
      apy: p.rateBps / 10_000,
      status: enumKey(p.status) as "locked" | "unlocked",
      advance,
      debt,
      yieldAccrued: Number(big(p.cumulativeYield)) / decimals,
      native: nativeInfo.get((row.publicKey as PublicKey).toBase58()) ?? null,
      eth: chainIdx === 1 ? parseEthPositionId(Uint8Array.from(row.account.positionId)) : null,
    });
  }

  return {
    exists: true,
    accountKey,
    lamports,
    ownTotal: big(acct.inner.ownTotal),
    wonTotal: big(acct.inner.wonTotal),
    holdings,
    positions,
    matches,
    market,
    funded,
    fetchedAt: Date.now(),
  };
}
