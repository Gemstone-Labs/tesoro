import "./polyfill";
import { BN } from "@coral-xyz/anchor";
import bs58Codec from "bs58";
import { PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import coreIdl from "./idl/tesoro_core.json";
import { basketPda, bookPda, decodeLine, spillPda, type Line } from "./basket";
import { coreIx } from "./core-ix";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import type { ChainHolding } from "./read";
import { NATIVE_ROUTE_AT } from "./fees";
import { exitSend, sourceAccounts } from "./redeem";
import { SponsorError, sponsorStatus } from "./sponsor-client";
import { SIM_SOL_MINT, RATE_SCALE, TESORO_CORE_ID, accountPda, createSimSolAtaIx, economyPda, lineArg, meta, nativePayingAccounts, pda, s, simSolAta, treasuryAccountPda, treasuryPda, treasuryVaultPda, nativeKindAccounts, CONFIG } from "./native";
import { stakePayingAccounts, stakeRateRemaining, stakeTokenOf, type StakeToken } from "./stake";
import { createAtaIdempotentIx, tokenAta } from "./stake-pool";

/**
 * Instant Redeem is an order that Tesoro fills (tesoro_core `ledger/instant`, `instructions/instant.rs`): the Player puts won
 * Gemas into an order; the fill authority buys all or part of it at 75% of their value at the moment of the fill, from the
 * route's spendable shares. The Player can cancel any time before they are sold; anyone returns them after the deadline.
 */

/** The Instant Redeem Fee at launch, in basis points of the Gemas' value (`INSTANT_REDEEM_FEE_BPS`). */
export const INSTANT_REDEEM_FEE_BPS = 2_500;
export const DEFAULT_ORDER_TTL_SECS = 7 * 24 * 60 * 60;
export const MIN_ORDER_TTL_SECS = 60 * 60;
export const MAX_ORDER_TTL_SECS = 30 * 24 * 60 * 60;
const SHARE_BITS = 32n;
const BPS = 10_000n;

export const instantOrderPda = (account: PublicKey, nonce: bigint | number) => {
  const n = Buffer.alloc(8);
  new DataView(n.buffer, n.byteOffset, n.byteLength).setBigUint64(0, BigInt(nonce), true);
  return pda([s("instant"), account.toBuffer(), n]);
};
export const sponsorPdaKey = () => pda([s("sponsor")]);

// ---- Orders ------------------------------------------------------------------------------------------

/** `InstantOrderState`: disc 8, bump, nonce, account, owner, line (144), requested, created_at, expires_at, sold, redeemed_while_open, paid_shares (u128), payer, sponsored_lamports. */
export const INSTANT_ORDER_LEN = 8 + 1 + 8 + 32 + 32 + 144 + 8 + 8 + 8 + 8 + 8 + 16 + 32 + 8;

export interface InstantOrder {
  address: PublicKey;
  nonce: bigint;
  /** The seller's TesoroAccount and wallet. */
  account: PublicKey;
  owner: PublicKey;
  /** The Gemas still on offer (same Source, side, class, tranche and due date as the line they came from). */
  line: Line;
  source: PublicKey;
  requested: bigint;
  createdAt: number;
  expiresAt: number;
  /** Gemas Tesoro has bought so far. */
  sold: bigint;
  /** Gemas redeemed at full value while the order waited. */
  redeemedWhileOpen: bigint;
  paidShares: bigint;
  /** Who paid the order's rent: the seller, or the relayer when it was sponsored. */
  payer: PublicKey;
  sponsoredLamports: bigint;
}

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, at: number) => dv(d).getBigUint64(at, true);
const i64 = (d: Uint8Array, at: number) => Number(dv(d).getBigInt64(at, true));
const u128 = (d: Uint8Array, at: number) => u64(d, at) + (u64(d, at + 8) << 64n);

export function decodeOrder(address: PublicKey, data: Uint8Array): InstantOrder {
  if (data.length < INSTANT_ORDER_LEN) throw new Error("Instant Redeem order shorter than expected");
  const line = decodeLine(data, 8 + 1 + 8 + 64);
  const at = 8 + 1 + 8 + 64 + 144;
  return {
    address,
    nonce: u64(data, 9),
    account: new PublicKey(data.slice(17, 49)),
    owner: new PublicKey(data.slice(49, 81)),
    line,
    source: line.source,
    requested: u64(data, at),
    createdAt: i64(data, at + 8),
    expiresAt: i64(data, at + 16),
    sold: u64(data, at + 24),
    redeemedWhileOpen: u64(data, at + 32),
    paidShares: u128(data, at + 40),
    payer: new PublicKey(data.slice(at + 56, at + 88)),
    sponsoredLamports: u64(data, at + 88),
  };
}

/** What the Player sees: waiting for Tesoro to buy, partly bought, or past its deadline (anyone can return the rest). */
export type OrderState = "requested" | "partly-sold" | "expired" | "finished";

export function orderState(o: Pick<InstantOrder, "line" | "sold" | "expiresAt">, nowSec: number): OrderState {
  if (o.line.amount === 0n) return "finished";
  if (nowSec >= o.expiresAt) return "expired";
  return o.sold > 0n ? "partly-sold" : "requested";
}

/** Gemas still on offer. */
export const remainingOf = (o: Pick<InstantOrder, "line">) => o.line.amount;

const discOf = (name: string) => Buffer.from((coreIdl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === name)!.discriminator);

/** The Account's open orders, oldest first. One filtered `getProgramAccounts` on the discriminator and the seller's Account. */
export async function fetchInstantOrders(accountKey: PublicKey, conn: Pick<Connection, "getProgramAccounts"> = getChain().base): Promise<InstantOrder[]> {
  const rows = await conn.getProgramAccounts(TESORO_CORE_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Codec.encode(discOf("InstantOrderState")) } }, { memcmp: { offset: 17, bytes: accountKey.toBase58() } }],
  });
  return rows.flatMap((r) => {
    if (r.account.data.length !== INSTANT_ORDER_LEN) return [];
    try {
      const o = decodeOrder(r.pubkey, r.account.data);
      return o.line.amount > 0n ? [o] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.createdAt - b.createdAt);
}


// ---- Request / cancel / expire --------------------------------------------------------------------------

type Reader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | { data: Uint8Array } | null)[]> };
type LineHolding = Pick<ChainHolding, "line" | "accounts" | "source" | "position" | "stakeMint" | "native" | "eth">;

const tokenOf = (mint: PublicKey | null | undefined): StakeToken | null => {
  if (!mint) return null;
  const token = stakeTokenOf(mint);
  if (!token) throw new Error("This Lock's staking token is not supported by this version of the app.");
  return token;
};

/**
 * `request_instant_redeem`: sells `sell` Gemas of one won line. The line's ready Gemas are redeemed at full value first (paid to the
 * seller's token account, which must exist for a Solana Source). `payer` is the Player, or the relayer with `sponsored`.
 */
export function requestInstantRedeemIx(args: { holder: PublicKey; payer: PublicKey; sponsored: boolean; h: LineHolding; sell: bigint; nonce: bigint; ttlSecs?: number; book: PublicKey[] }): TransactionInstruction {
  const { holder, payer, sponsored, h, sell, nonce, book } = args;
  const account = accountPda(holder);
  const token = tokenOf(h.stakeMint);
  // An EVM Source pays on its own chain, through the bridge's fill: no payout accounts here.
  const kind = h.eth ? [] : token ? stakePayingAccounts(tokenAta(holder, token.mint), token) : nativePayingAccounts(simSolAta(holder));
  return coreIx(
    "request_instant_redeem",
    {
      payer,
      holder_authority: holder,
      holder_account: account,
      basket: basketPda(account),
      spill: spillPda(account),
      position: h.position,
      source: h.source,
      order: instantOrderPda(account, nonce),
      sponsor: sponsored ? sponsorPdaKey() : null,
    },
    { line: lineArg(h.line), sell, ttl_secs: new BN(args.ttlSecs ?? DEFAULT_ORDER_TTL_SECS), nonce },
    [...kind, ...book.map((k) => meta(k, true))],
  );
}

/** Puts `sell` Gemas of a won line on offer. The relayer fronts the order's rent when it can (a Player with no SOL can still sell). */
export async function requestInstantRedeem(signer: ChainSigner, getToken: GetToken, h: LineHolding, sell: bigint, conn: Reader = getChain().base): Promise<string> {
  const me = signer.publicKey;
  const nonce = BigInt(Date.now());
  const { accounts, create } = await sourceAccounts(conn as never, h.source, h.accounts, me);
  const token = tokenOf(h.stakeMint);
  const ata = h.eth ? null : token ? tokenAta(me, token.mint) : simSolAta(me);
  const have = ata ? (await conn.getMultipleAccountsInfo([ata]))[0] : true;
  const prefix = have ? [] : [createAtaIdempotentIx(me, me, token?.mint ?? SIM_SOL_MINT)];
  const own = requestInstantRedeemIx({ holder: me, payer: me, sponsored: false, h, sell, nonce, book: accounts });
  // EVM Sources cannot return an order's rent to the sponsor; native first-use preparation is atomic with the request.
  if (!h.eth && signer.signSerialized) {
    try {
      const { relayer, paused } = await sponsorStatus();
      if (!paused) {
        return await exitSend(signer, getToken, [...create, ...prefix, requestInstantRedeemIx({ holder: me, payer: new PublicKey(relayer), sponsored: true, h, sell, nonce, book: accounts })], { selfPayIxs: [...create, ...prefix, own] });
      }
    } catch (e) {
      if (!(e instanceof SponsorError) || !(e.selfPay || e.code === "unsupported-wallet")) throw e;
    }
  }
  return getChain().sendBase(signer, [...create, ...prefix, own]);
}

type OrderAccounts = Pick<InstantOrder, "account" | "address" | "payer" | "sponsoredLamports" | "source" | "owner">;

function returnIx(name: "cancel_instant_redeem" | "expire_instant_redeem", signer: PublicKey, o: OrderAccounts, book: PublicKey[]) {
  return coreIx(
    name,
    {
      signer,
      owner_account: o.account,
      basket: basketPda(o.account),
      spill: spillPda(o.account),
      order: o.address,
      owner_wallet: o.payer,
      sponsor: o.sponsoredLamports > 0n ? sponsorPdaKey() : null,
    },
    {},
    book.map((k) => meta(k, true)),
  );
}

export const cancelInstantRedeemIx = (signer: PublicKey, o: OrderAccounts, book: PublicKey[] = [bookPda(o.source)]) => returnIx("cancel_instant_redeem", signer, o, book);
export const expireInstantRedeemIx = (signer: PublicKey, o: OrderAccounts, book: PublicKey[] = [bookPda(o.source)]) => returnIx("expire_instant_redeem", signer, o, book);

/** Takes the unsold Gemas back (the seller, any time). Free to the Player when the relayer takes it. */
export async function cancelInstantRedeem(signer: ChainSigner, getToken: GetToken, o: InstantOrder, conn: Reader = getChain().base): Promise<string> {
  const { accounts } = await sourceAccounts(conn as never, o.source, [], signer.publicKey);
  return exitSend(signer, getToken, [cancelInstantRedeemIx(signer.publicKey, o, accounts)]);
}

/** Returns the unsold Gemas of an order past its deadline to its seller (anyone may). */
export async function expireInstantRedeem(signer: ChainSigner, getToken: GetToken, o: InstantOrder, conn: Reader = getChain().base): Promise<string> {
  const { accounts } = await sourceAccounts(conn as never, o.source, [], signer.publicKey);
  return exitSend(signer, getToken, [expireInstantRedeemIx(signer.publicKey, o, accounts)]);
}

// ---- Fill (admin / keeper) -----------------------------------------------------------------------------

export { parseRoute, parseNativeRoute, type RouteView } from "./fees";
/** Route offset in `StakeCustody` (the native one plus three u64 counters). */
export const STAKE_ROUTE_AT = NATIVE_ROUTE_AT + 3 * 8;

/**
 * Shares the Treasury pays for `gemas` of a Source at fill time: their value in shares at the Source's price and the rate of the
 * moment (`shares_for_gemas`, whole shares), less the Instant Redeem Fee, each floored as on chain. `scale`/`rate`: native 1e9 and the
 * sim_lst rate, stake 1e12 and the Staking Rate.
 */
export function fillPayoutShares(gemas: bigint, src: { unitNum: bigint; unitDen: bigint }, rate: { scale: bigint; rate: bigint }, feeBps = INSTANT_REDEEM_FEE_BPS): { value: bigint; payout: bigint } {
  if (src.unitNum === 0n || rate.rate === 0n) return { value: 0n, payout: 0n };
  const unitsFp = ((gemas << 64n) * src.unitNum) / src.unitDen;
  const value = ((unitsFp * rate.scale) / (rate.rate << SHARE_BITS)) >> SHARE_BITS;
  return { value, payout: (value * (BPS - BigInt(feeBps))) / BPS };
}

/**
 * The most Gemas a fill can buy now without the Treasury paying more than `spendable` shares (`InstantOrder::max_fill`): Gemas
 * of the order that are ready are redeemed to the seller first and are not for sale. Exact inverse search, as on chain.
 */
export function maxFill(args: { remaining: bigint; ready: bigint; spendable: bigint; src: { unitNum: bigint; unitDen: bigint }; rate: { scale: bigint; rate: bigint }; feeBps?: number }): bigint {
  const ready = args.ready < args.remaining ? args.ready : args.remaining;
  let lo = 0n;
  let hi = args.remaining - ready;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (fillPayoutShares(mid, args.src, args.rate, args.feeBps).payout <= args.spendable) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * `fill_instant_redeem` (the fill authority signs): buys `gemas` of a Solana order. The payout goes to the seller's token account,
 * created first when missing (the filler pays). Remaining: the kind's accounts paying to the seller, for a simSOL Source the Treasury's
 * vault, then the Source's book and pages. EVM orders are filled by the bridge (`fill_instant_redeem_from_source`), never here.
 */
export function fillInstantRedeemIxs(args: { filler: PublicKey; order: InstantOrder; position: PublicKey; stakeMint: PublicKey | null; gemas: bigint; book: PublicKey[] }): TransactionInstruction[] {
  const { filler, order, position, stakeMint, gemas, book } = args;
  const token = tokenOf(stakeMint);
  const kind = token ? stakePayingAccounts(tokenAta(order.owner, token.mint), token) : [...nativePayingAccounts(simSolAta(order.owner)), meta(treasuryVaultPda(), true)];
  const ata = token ? createAtaIdempotentIx(filler, order.owner, token.mint) : createSimSolAtaIx(filler, order.owner);
  return [
    ata,
    coreIx(
      "fill_instant_redeem",
      {
        filler,
        config: CONFIG,
        economy: economyPda(),
        treasury: treasuryPda(),
        treasury_account: treasuryAccountPda(),
        treasury_basket: basketPda(treasuryAccountPda()),
        treasury_spill: spillPda(treasuryAccountPda()),
        order: order.address,
        owner_wallet: order.payer,
        sponsor: order.sponsoredLamports > 0n ? sponsorPdaKey() : null,
        position,
        source: order.source,
      },
      { gemas },
      [...kind, ...book.map((k) => meta(k, true))],
    ),
  ];
}

export { RATE_SCALE, stakeRateRemaining, nativeKindAccounts };
