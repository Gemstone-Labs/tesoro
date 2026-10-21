import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { BRIDGE, ENDPOINT_SETTINGS, STORE, AUTHORITY, CORE, disc, meta, peerPda, u32be } from "./lz.ts";
import { accountDisc } from "./lz.ts";
import { configAddress, economyAddress, pda } from "./kit.ts";

/** What the keeper needs of the bridge program (programs of ticket 16: bridge/programs/tesoro_bridge/src). */

const bePda = (seed: string, ...parts: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], BRIDGE)[0];
const u64be = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const w = (pubkey: PublicKey, signer = false) => meta(pubkey, signer, true);
const r = (pubkey: PublicKey) => meta(pubkey);

/** The 32-byte word of a vault address: 12 zero bytes, then the 20 address bytes. */
export const vaultWordOf = (vault20: Uint8Array) => Buffer.concat([Buffer.alloc(12), Buffer.from(vault20)]);

/** A Position id whose first 20 bytes are the vault (the rest zero): stands in where the send helpers want a Position id for the vault. */
export const vaultPositionId = (peerAddress: Uint8Array) => Uint8Array.from(Buffer.concat([Buffer.from(peerAddress.subarray(12, 32)), Buffer.alloc(12)]));

export const routePda = (eid: number, peerAddress: Uint8Array) => bePda("route", u32be(eid), Buffer.from(peerAddress));
export const batchPda = (eid: number, peerAddress: Uint8Array, id: bigint | number) => bePda("batch", u32be(eid), Buffer.from(peerAddress), u64be(id));
export const payoutPda = (eid: number, peerAddress: Uint8Array, id: bigint | number) => bePda("payout", u32be(eid), Buffer.from(peerAddress), u64be(id));
export const claimPda = (holder: PublicKey, source: PublicKey) => bePda("claim", holder.toBuffer(), source.toBuffer());
const peerOf = (eid: number, peerAddress: Uint8Array) => peerPda(eid, vaultPositionId(peerAddress));

/** The byte core puts in a Position's PDA seeds and in `source_auth` seeds for a chain. */
export const chainByteOf = (chain: "solana" | "ethereum" | "hyperEvm") => (chain === "ethereum" ? 1 : chain === "hyperEvm" ? 2 : 0);
const sourceAuth = (chain: "ethereum" | "hyperEvm") => pda("source_auth", Buffer.from([chainByteOf(chain)]));

/** Which core chain an LayerZero endpoint id belongs to (Hoodi and Ethereum, HyperEVM testnet and mainnet). */
export const chainOfEid = (eid: number): "ethereum" | "hyperEvm" | null => (eid === 40449 || eid === 30101 ? "ethereum" : eid === 40362 || eid === 30367 ? "hyperEvm" : null);

// ---- Account decoders (8-byte discriminator, then the fields in order) ------------------------------------------------

export const bridgeDisc = { route: accountDisc("VaultRoute"), batch: accountDisc("Batch"), payout: accountDisc("PayoutRecord"), claim: accountDisc("Claim"), instantClaim: accountDisc("InstantClaim") };

export interface RouteRow {
  address: PublicKey;
  eid: number;
  peerAddress: Buffer;
  asset: Buffer;
  escrowEnabled: boolean;
  minBatchUnits: bigint;
  lastBatchId: bigint;
  lastPayoutId: bigint;
  escrowShares: bigint;
  escrowUnits: bigint;
  issuedShares: bigint;
  issuedUnits: bigint;
  lastFundedSeason: number;
}

const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export function decodeRoute(address: PublicKey, d: Buffer): RouteRow {
  return {
    address,
    eid: d.readUInt32LE(8),
    peerAddress: Buffer.from(d.subarray(12, 44)),
    asset: Buffer.from(d.subarray(45, 77)),
    escrowEnabled: d[77] === 1,
    minBatchUnits: d.readBigUInt64LE(78),
    lastBatchId: d.readBigUInt64LE(86),
    lastPayoutId: d.readBigUInt64LE(94),
    escrowShares: u128(d, 102),
    escrowUnits: u128(d, 118),
    issuedShares: u128(d, 134),
    issuedUnits: u128(d, 150),
    lastFundedSeason: d.readUInt32LE(166),
  };
}

export const BATCH_OPEN = 0;
export const BATCH_SEALED = 1;
export const BATCH_DONE = 2;
export const MAX_BATCH_ENTRIES = 8;

export interface BatchRow {
  address: PublicKey;
  eid: number;
  peerAddress: Buffer;
  id: bigint;
  rentPayer: PublicKey;
  kind: number;
  state: number;
  count: number;
  totalUnits: bigint;
  paidUnits: bigint;
  sends: number;
}

export function decodeBatch(address: PublicKey, d: Buffer): BatchRow {
  const entriesAt = 108;
  const entriesLen = MAX_BATCH_ENTRIES * 64;
  return {
    address,
    eid: d.readUInt32LE(8),
    peerAddress: Buffer.from(d.subarray(12, 44)),
    id: d.readBigUInt64LE(44),
    rentPayer: new PublicKey(d.subarray(53, 85)),
    kind: d[85],
    state: d[86],
    count: d[107],
    totalUnits: u128(d, entriesAt + entriesLen),
    paidUnits: u128(d, entriesAt + entriesLen + 16),
    sends: d.readUInt32LE(entriesAt + entriesLen + 32),
  };
}

export const PAYOUT_PENDING = 0;
export const PAYOUT_PAID = 1;
export const PAYOUT_REJECTED = 2;
export const PAYOUT_REFUNDED = 3;

export interface PayoutRow {
  address: PublicKey;
  eid: number;
  peerAddress: Buffer;
  id: bigint;
  rentPayer: PublicKey;
  state: number;
  holderAccount: PublicKey;
  prizeSource: PublicKey;
  gemas: bigint;
  shares: bigint;
}

export function decodePayout(address: PublicKey, d: Buffer): PayoutRow {
  return {
    address,
    eid: d.readUInt32LE(8),
    peerAddress: Buffer.from(d.subarray(12, 44)),
    id: d.readBigUInt64LE(44),
    rentPayer: new PublicKey(d.subarray(53, 85)),
    state: d[85],
    holderAccount: new PublicKey(d.subarray(86, 118)),
    prizeSource: new PublicKey(d.subarray(138, 170)),
    gemas: d.readBigUInt64LE(202),
    shares: u128(d, 210),
  };
}

export interface ClaimRow {
  address: PublicKey;
  holderAccount: PublicKey;
  source: PublicKey;
  position: PublicKey;
  unitsTotal: bigint;
  unitsSent: bigint;
}

/** A `Claim` or an `InstantClaim` (same layout). */
export function decodeClaim(address: PublicKey, d: Buffer): ClaimRow {
  const k = (o: number) => new PublicKey(d.subarray(o, o + 32));
  return { address, holderAccount: k(8), source: k(40), position: k(72), unitsTotal: d.readBigUInt64LE(112), unitsSent: d.readBigUInt64LE(120) };
}

// ---- Instructions -----------------------------------------------------------------------------------------------------

const ix = (keys: AccountMeta[], data: Buffer) => new TransactionInstruction({ programId: BRIDGE, keys, data });
const sendTail = (nativeFee: bigint) => Buffer.concat([u32le(0), u64le(nativeFee), u64le(0n)]);

export const openBatchIx = (o: { payer: PublicKey; route: RouteRow; kind: number }) =>
  ix(
    [w(o.payer, true), r(STORE), r(peerOf(o.route.eid, o.route.peerAddress)), w(o.route.address), w(batchPda(o.route.eid, o.route.peerAddress, o.route.lastBatchId + 1n)), r(SystemProgram.programId)],
    Buffer.concat([disc("open_batch"), u32le(o.route.eid), o.route.peerAddress, Buffer.from([o.kind])]),
  );

export const addToBatchIx = (o: {
  batch: BatchRow;
  chain: "ethereum" | "hyperEvm";
  recipientAccount: PublicKey;
  position: PublicKey;
  source: PublicKey;
  /** The Source's book and checkpoint pages. */
  remaining: AccountMeta[];
}) =>
  ix(
    [r(STORE), r(AUTHORITY), w(o.batch.address), r(sourceAuth(o.chain)), r(configAddress), r(economyAddress), r(o.recipientAccount), w(o.position), w(o.source), r(CORE), ...o.remaining],
    disc("add_to_batch"),
  );

export const sealBatchIx = (batch: BatchRow) => ix([r(routePda(batch.eid, batch.peerAddress)), w(batch.address)], disc("seal_batch"));

export const sendBatchIx = (o: { payer: PublicKey; batch: BatchRow; nativeFee: bigint; send: AccountMeta[] }) =>
  ix(
    [w(o.payer, true), r(STORE), r(peerOf(o.batch.eid, o.batch.peerAddress)), w(o.batch.address), r(SystemProgram.programId), ...o.send],
    Buffer.concat([disc("send_batch"), u32le(o.batch.eid), o.batch.peerAddress, u64le(o.batch.id), sendTail(o.nativeFee)]),
  );

export const closeBatchIx = (batch: BatchRow) => ix([w(batch.address), w(batch.rentPayer)], disc("close_batch"));

export const sendPayPrizeIx = (o: { payer: PublicKey; payout: PayoutRow; nativeFee: bigint; send: AccountMeta[] }) =>
  ix(
    [w(o.payer, true), r(STORE), r(peerOf(o.payout.eid, o.payout.peerAddress)), w(o.payout.address), r(SystemProgram.programId), ...o.send],
    Buffer.concat([disc("send_pay_prize"), u32le(o.payout.eid), o.payout.peerAddress, u64le(o.payout.id), sendTail(o.nativeFee)]),
  );

export const refundPrizePayoutIx = (o: { payout: PayoutRow; holderBasket: PublicKey; holderSpill: PublicKey }) =>
  ix(
    [
      r(STORE),
      r(AUTHORITY),
      w(routePda(o.payout.eid, o.payout.peerAddress)),
      w(o.payout.address),
      r(sourceAuth(chainOfEid(o.payout.eid)!)),
      r(o.payout.holderAccount),
      w(o.holderBasket),
      w(o.holderSpill),
      w(o.payout.prizeSource),
      r(CORE),
    ],
    disc("refund_prize_payout"),
  );

export const closePayoutIx = (payout: PayoutRow) => ix([w(payout.address), w(payout.rentPayer)], disc("close_payout"));

export const fundSeasonPrizeEvmIx = (o: {
  payer: PublicKey;
  seasonAuthority: PublicKey;
  oracle: PublicKey | null;
  route: RouteRow;
  season: number;
  priceMicroUsd: bigint;
  poolAccount: PublicKey;
  poolBasket: PublicKey;
  poolSpill: PublicKey;
  prizeSource: PublicKey;
  /** The asset's `OnchainPrice` address, then its feed when that account exists. */
  remaining: AccountMeta[];
}) =>
  ix(
    [
      w(o.payer, true),
      meta(o.seasonAuthority, true, false),
      o.oracle ? meta(o.oracle, true, false) : r(BRIDGE),
      r(STORE),
      r(AUTHORITY),
      r(peerOf(o.route.eid, o.route.peerAddress)),
      w(o.route.address),
      r(sourceAuth(chainOfEid(o.route.eid)!)),
      r(configAddress),
      r(economyAddress),
      r(o.poolAccount),
      w(o.poolBasket),
      w(o.poolSpill),
      w(o.prizeSource),
      r(CORE),
      r(SystemProgram.programId),
      ...o.remaining,
    ],
    Buffer.concat([disc("fund_season_prize_evm"), u32le(o.route.eid), o.route.peerAddress, u32le(o.season), u64le(o.priceMicroUsd)]),
  );

export const redeemTreasuryToEvmIx = (o: {
  payer: PublicKey;
  chain: "ethereum" | "hyperEvm";
  treasury: PublicKey;
  treasuryAccount: PublicKey;
  treasuryBasket: PublicKey;
  treasurySpill: PublicKey;
  position: PublicKey;
  source: PublicKey;
  line: { side: number; dueAt: bigint; cls: number; tranche: number };
  gemas: bigint;
  remaining: AccountMeta[];
}) =>
  ix(
    [
      w(o.payer, true),
      r(STORE),
      r(AUTHORITY),
      r(sourceAuth(o.chain)),
      r(o.treasury),
      r(o.treasuryAccount),
      w(o.treasuryBasket),
      w(o.treasurySpill),
      w(o.position),
      w(o.source),
      w(claimPda(o.treasuryAccount, o.source)),
      r(CORE),
      r(SystemProgram.programId),
      ...o.remaining,
    ],
    Buffer.concat([disc("redeem_treasury_to_evm"), Buffer.from([o.line.side]), i64le(o.line.dueAt), Buffer.from([o.line.cls, o.line.tranche]), u64le(o.gemas)]),
  );

export { ENDPOINT_SETTINGS };
