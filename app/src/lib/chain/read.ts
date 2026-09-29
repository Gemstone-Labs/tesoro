import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain, TESORO_CORE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { debtGemas, debtUnits, redeemableFor, type SourceMath } from "./ledger";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());

export type MatchStatus = "open" | "active" | "settled" | "refunded";

/** A Match as the signed-in Account sees it. */
export interface ChainMatch {
  id: bigint;
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
  fees: { platformBps: number; studioBps: number };
  /** Set as soon as the Match is opened (the opener plays before anyone is paired). */
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
  fetchedAt: number;
}

const ASSETS = ["SOL", "ETH", "HYPE"] as const;
const enumKey = (o: object) => Object.keys(o)[0];
const isChallengeId = (id: bigint) => (id & 1n) === 1n;

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

export function toChainMatch(state: any, me: PublicKey | null, session: any | null): ChainMatch {
  const m = state.inner;
  const a = pk(m.a.player).toBase58();
  const b = m.b ? pk(m.b.player).toBase58() : null;
  const mine = me?.toBase58();
  const seat = mine === a ? 0 : mine && mine === b ? 1 : null;
  const id = big(state.id);
  return {
    id,
    address: BlockPuzzleChain.addresses(id).match,
    status: enumKey(m.status).toLowerCase() as MatchStatus,
    entry: Number(m.entry.toString()),
    seat,
    opponent: seat === 0 ? b : seat === 1 ? a : null,
    deadline: Number(m.deadline.toString()),
    challenge: isChallengeId(id),
    fees: { platformBps: m.fees.platformBps, studioBps: m.fees.studioBps },
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
  const session = await chain.bp.account.session.fetchNullable(a.session).catch(() => null);
  return toChainMatch(state, me, session);
}

/** Every Match this Account is in, newest first. */
async function fetchMyMatches(me: PublicKey): Promise<ChainMatch[]> {
  const chain = getChain();
  const all = await chain.core.account.matchState.all();
  const mine = all.filter((m: any) => {
    const inner = m.account.inner;
    return pk(inner.game).equals(BLOCK_PUZZLE_PROGRAM_ID) && (pk(inner.a.player).equals(me) || (inner.b && pk(inner.b.player).equals(me)));
  });
  const sessionKeys = mine.map((m: any) => BlockPuzzleChain.addresses(big(m.account.id)).session);
  const sessions = sessionKeys.length ? await chain.bp.account.session.fetchMultiple(sessionKeys) : [];
  return mine
    .map((m: any, i: number) => toChainMatch(m.account, me, sessions[i] ?? null))
    .sort((x: ChainMatch, y: ChainMatch) => (x.id < y.id ? 1 : -1));
}

/** The oldest Open Queue Match at this entry from another Account, if any (Challenges are excluded). */
export async function findQueueMatch(entry: number, me: PublicKey): Promise<bigint | null> {
  const chain = getChain();
  const now = Math.floor(Date.now() / 1000);
  const all = await chain.core.account.matchState.all();
  const open = all
    .filter((m: any) => {
      const inner = m.account.inner;
      return (
        enumKey(inner.status) === "open" &&
        pk(inner.game).equals(BLOCK_PUZZLE_PROGRAM_ID) &&
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

/** Number of Open Queue Matches per entry size (for the Lobby). */
export async function queueDepth(): Promise<number> {
  const chain = getChain();
  const now = Math.floor(Date.now() / 1000);
  const all = await chain.core.account.matchState.all();
  return all.filter((m: any) => {
    const inner = m.account.inner;
    return enumKey(inner.status) === "open" && pk(inner.game).equals(BLOCK_PUZZLE_PROGRAM_ID) && !isChallengeId(big(m.account.id)) && Number(inner.deadline.toString()) > now;
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
    fetchedAt: Date.now(),
  };
  if (!acct) return empty;

  const [holdingRows, positionRows, matches] = await Promise.all([
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
    fetchedAt: Date.now(),
  };
}
