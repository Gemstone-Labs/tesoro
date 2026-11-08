import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { bookPda } from "@/lib/chain/basket";
import { decodeBook, fpFloor, readyNow, syncPreview, type SourceBookView } from "@/lib/chain/book";
import { INSTANT_ORDER_LEN, INSTANT_REDEEM_FEE_BPS, STAKE_ROUTE_AT, decodeOrder, fillPayoutShares, maxFill, orderState, type InstantOrder, type OrderState } from "@/lib/chain/instant-order";
import { NATIVE_ROUTE_AT, parseRoute, type RouteView } from "@/lib/chain/fees";
import { positionBytes } from "@/lib/chain/position-size";
import { POOL, RATE_SCALE, SIM_SOL_MINT, TESORO_CORE_ID, clockOf, nativeCustodyPda, rateAt, rdI64, rdU32, rdU64, type PoolParams } from "@/lib/chain/native";
import { baseRpc } from "@/lib/chain/rpc-config";
import { JITOSOL, STAKE_CUSTODY_LEN, stakeCustodyPda } from "@/lib/chain/stake";
import { STAKE_RATE_SCALE, parseStakePool, stakePoolRate } from "@/lib/chain/stake-pool";
import { positionAccrued } from "@/lib/chain/yield";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import { parseAdmins } from "./review";

/**
 * The admin's list of open Instant Redeem orders: what each seller offers, what is ready (redeemed to the seller first),
 * and the most the Treasury route can buy now (`InstantOrder::max_fill`), so a fill is all or part of the order.
 * Chain reads only; the admin wallet signs the fill itself with `fillInstantRedeemIxs` (lib/chain/instant-order.ts).
 */

type Info = AccountInfo<Buffer> | null;
const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const key = (b: number[] | Uint8Array) => new PublicKey(Uint8Array.from(b));
const big = (n: { toString(): string }) => BigInt(n.toString());

/** The `Position` fields the orders page uses, read once from the coder's output (IDL names: snake_case fields, PascalCase enum variants). */
export interface PositionView {
  chain: "solana" | "ethereum" | "hyperEvm";
  asset: PublicKey;
  principal: bigint;
  rateBps: number;
  locked: boolean;
  openAdvance: number | null;
  openedAt: number;
  appliedNet: bigint;
  stakeRateOpen: bigint;
  stakeRateHigh: bigint;
}

/** The `Source` fields the orders page uses. */
export interface SourceView {
  position: PublicKey;
  index: number;
  unitNum: bigint;
  unitDen: bigint;
}

const CHAINS = { Solana: "solana", Ethereum: "ethereum", HyperEvm: "hyperEvm" } as const;
const variant = (o: object) => Object.keys(o)[0];

/** Decodes a `PositionState` account (either live size); throws on data that is not one. */
export function decodePosition(data: Buffer): PositionView {
  const p = coder.decode("PositionState", positionBytes(data)).inner;
  const chain = CHAINS[variant(p.source_chain) as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unknown source chain ${variant(p.source_chain)}`);
  return {
    chain,
    asset: key(p.source_asset),
    principal: big(p.principal),
    rateBps: p.rate_bps,
    locked: variant(p.status) === "Locked",
    openAdvance: p.open_advance ?? null,
    openedAt: Number(big(p.opened_at)),
    appliedNet: big(p.applied_net),
    stakeRateOpen: big(p.stake_rate_open),
    stakeRateHigh: big(p.stake_rate_high),
  };
}

/** Decodes a `SourceState` account; throws on data that is not one. */
export function decodeSource(data: Buffer): SourceView {
  const s = coder.decode("SourceState", data).inner;
  return { position: key(s.position), index: s.index, unitNum: big(s.unit_num), unitDen: big(s.unit_den) };
}

export interface RouteJson {
  treasuryShares: string;
  owedShares: string;
  poolOwed: string;
  reserved: string;
  spendable: string;
}

export interface AdminOrder {
  address: string;
  nonce: string;
  account: string;
  owner: string;
  source: string;
  position: string;
  /** Who pays out: the Treasury of this kind buys the order. `reported` (ETH, HYPE) orders are filled by the bridge, not here. */
  kind: "native" | "stake" | "reported";
  stakeMint: string | null;
  asset: "SOL" | "ETH" | "HYPE";
  state: OrderState;
  requested: number;
  sold: number;
  /** Gemas still on offer. */
  remaining: number;
  /** Of those, Gemas whose yield has landed: the fill redeems them to the seller at full value first. */
  ready: number;
  /** Most Gemas the route can buy now (0 for a bridge order). */
  maxFill: number;
  /** Shares paid for `maxFill`. */
  maxFillPayoutShares: string;
  createdAt: number;
  expiresAt: number;
  sponsored: boolean;
  payer: string;
  /** The Source's book and checkpoint pages to pass to the fill: the book first (the page list is the client's, see `sourceAccounts`). */
  book: string;
}

export interface OrdersReply {
  now: number;
  /** The Treasury's shares on each route, null when the route does not exist. */
  routes: { native: RouteJson | null; stake: RouteJson | null };
  orders: AdminOrder[];
}

const routeJson = (r: RouteView | null): RouteJson | null =>
  r && { treasuryShares: String(r.treasuryShares), owedShares: String(r.owedShares), poolOwed: String(r.poolOwed), reserved: String(r.reserved), spendable: String(r.spendable) };

/** Everything the build needs, read in two rounds. */
export interface OrdersRaw {
  orders: InstantOrder[];
  /** Decoded Sources and Positions by address, and raw Source book accounts. */
  sources: Map<string, SourceView>;
  positions: Map<string, PositionView>;
  books: Map<string, Buffer>;
  pool: PoolParams | null;
  stakeRate: bigint | null;
  routes: { native: RouteView | null; stake: RouteView | null };
}

const decodeOr = <T>(decode: (data: Buffer) => T, info: Info): T | null => {
  try {
    return info ? decode(info.data) : null;
  } catch {
    return null;
  }
};

/** The book as an order's Source stands now: the open Advance's coverage by the clock is landed first, as the fill does (`sync_in_books`). */
function syncedBook(book: SourceBookView, pos: PositionView, src: SourceView, pool: PoolParams | null, stakeRate: bigint | null, nowSec: number): SourceBookView {
  const native = pos.chain === "solana" && (pos.asset.equals(SIM_SOL_MINT) || pos.stakeRateOpen !== 0n);
  if (!native || pos.openAdvance !== src.index || !pos.locked) return book;
  const clock = clockOf({ principalLamports: pos.principal, rateBps: pos.rateBps, openedAt: pos.openedAt, stakeRateOpen: pos.stakeRateOpen, stakeRateHigh: pos.stakeRateHigh });
  const stake = stakeRate ? { rateNow: stakeRate, atSec: nowSec, apyBps: pos.rateBps } : undefined;
  const net = positionAccrued(clock, pool?.speedup ?? 1, nowSec, stake);
  return syncPreview(book, net > pos.appliedNet ? net - pos.appliedNet : 0n, { unitNum: src.unitNum, unitDen: src.unitDen });
}

export function buildOrdersReply(raw: OrdersRaw, nowSec: number): OrdersReply {
  const orders: AdminOrder[] = [];
  for (const o of raw.orders) {
    if (o.line.amount === 0n) continue;
    const src = raw.sources.get(o.source.toBase58());
    const posKey = src ? src.position.toBase58() : null;
    const pos = posKey ? raw.positions.get(posKey) : null;
    if (!src || !pos) continue;
    const bookData = raw.books.get(bookPda(o.source).toBase58());
    const chain = pos.chain;
    const kind: AdminOrder["kind"] = chain !== "solana" ? "reported" : pos.stakeRateOpen !== 0n ? "stake" : "native";
    let ready = 0n;
    let book: SourceBookView | null = null;
    try {
      book = bookData ? syncedBook(decodeBook(bookData), pos, src, raw.pool, raw.stakeRate, nowSec) : null;
      if (book) ready = fpFloor(readyNow(book, o.line));
    } catch {
      book = null;
    }
    const readyCapped = ready < o.line.amount ? ready : o.line.amount;
    const route = kind === "native" ? raw.routes.native : kind === "stake" ? raw.routes.stake : null;
    const rate = kind === "native" && raw.pool ? { scale: RATE_SCALE, rate: rateAt(raw.pool) } : kind === "stake" && raw.stakeRate ? { scale: STAKE_RATE_SCALE, rate: raw.stakeRate } : null;
    const unit = { unitNum: src.unitNum, unitDen: src.unitDen };
    const fill = route && rate && book ? maxFill({ remaining: o.line.amount, ready: readyCapped, spendable: route.spendable, src: unit, rate }) : 0n;
    orders.push({
      address: o.address.toBase58(),
      nonce: String(o.nonce),
      account: o.account.toBase58(),
      owner: o.owner.toBase58(),
      source: o.source.toBase58(),
      position: posKey!,
      kind,
      stakeMint: kind === "stake" ? pos.asset.toBase58() : null,
      asset: chain === "ethereum" ? "ETH" : chain === "hyperEvm" ? "HYPE" : "SOL",
      state: orderState(o, nowSec),
      requested: Number(o.requested),
      sold: Number(o.sold),
      remaining: Number(o.line.amount),
      ready: Number(readyCapped),
      maxFill: Number(fill),
      maxFillPayoutShares: String(rate ? fillPayoutShares(fill, unit, rate, INSTANT_REDEEM_FEE_BPS).payout : 0n),
      createdAt: o.createdAt,
      expiresAt: o.expiresAt,
      sponsored: o.sponsoredLamports > 0n,
      payer: o.payer.toBase58(),
      book: bookPda(o.source).toBase58(),
    });
  }
  orders.sort((a, b) => a.createdAt - b.createdAt);
  return { now: nowSec, routes: { native: routeJson(raw.routes.native), stake: routeJson(raw.routes.stake) }, orders };
}

const batch = async (conn: Pick<Connection, "getMultipleAccountsInfo">, keys: PublicKey[]): Promise<Info[]> => {
  const out: Info[] = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...((await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")) as Info[]));
  return out;
};

/** Reads every open order and what pricing it needs. */
export async function loadOrders(conn: Pick<Connection, "getProgramAccounts" | "getMultipleAccountsInfo">): Promise<OrdersRaw> {
  const disc = (coreIdl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === "InstantOrderState")!.discriminator;
  const bs58 = (await import("bs58")).default;
  const rows = await conn.getProgramAccounts(TESORO_CORE_ID, { filters: [{ dataSize: INSTANT_ORDER_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } }] });
  const orders = rows.flatMap((r) => {
    try {
      const o = decodeOrder(r.pubkey, r.account.data);
      return o.line.amount > 0n ? [o] : [];
    } catch {
      return [];
    }
  });
  const sourceKeys = [...new Map(orders.map((o) => [o.source.toBase58(), o.source])).values()];
  const stakeCustody = stakeCustodyPda(JITOSOL.mint);
  const [sourceInfos, bookInfos, fixed] = await Promise.all([
    batch(conn, sourceKeys),
    batch(conn, sourceKeys.map(bookPda)),
    batch(conn, [POOL, nativeCustodyPda(), stakeCustody, JITOSOL.pool]),
  ]);
  const sources = new Map<string, SourceView>();
  sourceKeys.forEach((k, i) => {
    const s = decodeOr(decodeSource, sourceInfos[i]);
    if (s) sources.set(k.toBase58(), s);
  });
  const positionKeys = [...new Map([...sources.values()].map((s) => [s.position.toBase58(), s.position])).values()];
  const positionInfos = await batch(conn, positionKeys);
  const positions = new Map<string, PositionView>();
  positionKeys.forEach((k, i) => {
    const p = decodeOr(decodePosition, positionInfos[i]);
    if (p) positions.set(k.toBase58(), p);
  });
  const books = new Map<string, Buffer>();
  sourceKeys.forEach((k, i) => {
    const info = bookInfos[i];
    if (info) books.set(bookPda(k).toBase58(), info.data);
  });
  const [poolInfo, nativeInfo, stakeInfo, stakePoolInfo] = fixed;
  const pool = poolInfo ? ({ baseRate: rdU64(poolInfo.data, 72), baseTs: Number(rdI64(poolInfo.data, 80)), apyBps: rdU32(poolInfo.data, 88), speedup: rdU32(poolInfo.data, 92) } satisfies PoolParams) : null;
  const sp = stakePoolInfo && stakePoolInfo.owner.equals(JITOSOL.poolProgram) ? parseStakePool(stakePoolInfo.data) : null;
  return {
    orders,
    sources,
    positions,
    books,
    pool,
    stakeRate: sp ? stakePoolRate(sp.totalLamports, sp.poolTokenSupply) : null,
    routes: {
      native: nativeInfo && nativeInfo.owner.equals(TESORO_CORE_ID) && nativeInfo.data.length > NATIVE_ROUTE_AT ? parseRoute(nativeInfo.data, NATIVE_ROUTE_AT) : null,
      stake: stakeInfo && stakeInfo.owner.equals(TESORO_CORE_ID) && stakeInfo.data.length === STAKE_CUSTODY_LEN ? parseRoute(stakeInfo.data, STAKE_ROUTE_AT) : null,
    },
  };
}

let conn: Connection | null = null;
const connection = async () => (conn ??= new (await import("@solana/web3.js")).Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

/** Every open Instant Redeem order with its fillable amount, read from the chain now. */
export async function listOpenOrders(nowMs = Date.now()): Promise<OrdersReply> {
  return buildOrdersReply(await loadOrders(await connection()), Math.floor(nowMs / 1000));
}

export interface OrdersDeps {
  admins: string[];
  list: (nowMs: number) => Promise<OrdersReply>;
}

const nonces = new NonceStore();

/** Admin-only, like the review page: a wallet-signed request from an address in ADMIN_WALLETS. */
export async function handleOrders(deps: OrdersDeps, body: unknown, authorization: string | null, env?: AuthEnv, now = Date.now()): Promise<OrdersReply> {
  if (!deps.admins.length) throw new DemoHttpError(503, "not-configured", "The orders page is not set up on this server.");
  const req = await verifySignedRequest("tesoro-admin", ["orders"] as const, body, authorization, { nonces, env, now });
  if (!deps.admins.includes(req.address.toBase58())) throw new DemoHttpError(403, "forbidden", "Not allowed.");
  return deps.list(now);
}

export const ordersDeps = (): OrdersDeps => ({ admins: parseAdmins(process.env.ADMIN_WALLETS), list: listOpenOrders });
