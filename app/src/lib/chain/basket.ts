/**
 * Baskets, spills, Source books and checkpoint pages as the client sees them (tesoro_core
 * `storage.rs` and `ledger/line_store`). Pure byte decoders over account data plus the PDA helpers
 * the instruction builders share. No network calls.
 *
 * Layout facts (little endian): a store body (after the 8-byte Anchor discriminator) is a 128-byte
 * header, then slots of `LINE_LEN` bytes. Lines occupy slots `first .. first + len` in ascending key
 * order (side, due_at, source, class, tranche); the draw takes from the front.
 */

import { PublicKey } from "@solana/web3.js";

export const TESORO_CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

export const DISC = 8;
export const HEADER_LEN = 128;
export const LINE_LEN = 144;
export const BASKET_VERSION = 3;
/** Slots a new basket starts with. */
export const INITIAL_BASKET_LINES = 4;
export const MAX_GROW_LINES = Math.floor(10_240 / LINE_LEN);
/** Largest basket / spill, in lines (ticket 09b raised it from 4,096). */
export const MAX_STORE_LINES = 32_768;

export const SIDE_OWN = 0;
export const SIDE_WON = 1;
export const CLASS_PLATFORM = 0;
export const CLASS_STUDIO = 1;
export const CLASS_LEADERBOARD = 2;
export const CLASS_GENERAL = 3;
export const FLAG_TICKET_OPEN = 1;
export const FLAG_BACKING_OPEN = 2;

/** Lines one `open_match` may draw directly; more needs a Ticket (`MAX_DIRECT_LINES`). */
export const MAX_DIRECT_LINES = 16;
/** `stage_entry` moves at most this many lines per call. */
export const MAX_STAGE_OPS = 32;

export const BOOK_HEAD_LEN = 40;
export const COUNTER_SLOTS = 3;
export const COUNTERS_AT = DISC + BOOK_HEAD_LEN;
export const BOOK_AT = COUNTERS_AT + COUNTER_SLOTS * LINE_LEN;
export const BOOK_FIXED_LEN = 82;
export const CLASS_LEN = 128;
export const CKPT_PAGE_AT = DISC + 8;
export const CKPT_RECORD_LEN = 48;
export const CKPT_PAGE_HEADER = 40;
export const CKPT_PER_PAGE = 32;

const utf = (s: string) => Buffer.from(s);
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE)[0];
const le64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const le32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

export const basketPda = (account: PublicKey) => pda([utf("basket"), account.toBuffer()]);
export const spillPda = (account: PublicKey) => pda([utf("spill"), account.toBuffer()]);
export const sponsorPda = () => pda([utf("sponsor")]);
export const bookPda = (source: PublicKey) => pda([utf("book"), source.toBuffer()]);
export const ckptPda = (source: PublicKey, classId: number, pageNo: number) => pda([utf("ckpt"), source.toBuffer(), Buffer.from([classId]), le32(pageNo)]);
export const countersPda = (account: PublicKey) => pda([utf("counters"), account.toBuffer()]);
/** The Match `n` the Account `opener` opened. */
export const matchPda = (opener: PublicKey, n: bigint | number) => pda([utf("match"), opener.toBuffer(), le64(n)]);
/** A Ticket, and the Pot it becomes: `["ticket", account, nonce]`. */
export const ticketPda = (account: PublicKey, nonce: bigint | number) => pda([utf("ticket"), account.toBuffer(), le64(nonce)]);
export const settledPda = (match: PublicKey) => pda([utf("settled"), match.toBuffer()]);

const rd64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const rdI64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(at, true);
const rd32 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);

/** Unsigned little-endian integer of `len` bytes. */
export function leBig(d: Uint8Array, at: number, len: number): bigint {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
}

/** The key that orders lines (and names one): side, due_at, source, class, tranche. */
export interface LineKey {
  side: number;
  dueAt: bigint;
  source: PublicKey;
  classId: number;
  tranche: number;
}

/** One basket line. Gemas are whole; `uncovered` is Gemas x 2^64 as of the snapshot (p, scale, epoch). */
export interface Line extends LineKey {
  amount: bigint;
  uncovered: bigint;
  p: bigint;
  scale: number;
  epoch: number;
  ck: number;
  /** Staking-token shares this line owns, 32 fractional bits. */
  shares: bigint;
}

export function decodeLine(raw: Uint8Array, at = 0): Line {
  const b = raw.subarray(at, at + LINE_LEN);
  return {
    side: b[0],
    classId: b[1],
    tranche: b[2],
    dueAt: rdI64(b, 3),
    source: new PublicKey(b.slice(11, 43)),
    amount: rd64(b, 43),
    uncovered: leBig(b, 51, 16),
    p: leBig(b, 67, 16),
    scale: rd32(b, 83),
    epoch: rd32(b, 87),
    ck: rd32(b, 91),
    shares: leBig(b, 95, 16),
  };
}

export function lineKeyBytes(k: LineKey): Uint8Array {
  const out = new Uint8Array(11 + 32);
  out[0] = k.side;
  new DataView(out.buffer).setBigInt64(3, k.dueAt, true);
  out.set(k.source.toBytes(), 11);
  return out;
}

/** Sort order of the store: side, due_at, source bytes, class, tranche. */
export function compareKeys(a: LineKey, b: LineKey): number {
  if (a.side !== b.side) return a.side - b.side;
  if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
  const c = Buffer.compare(a.source.toBuffer(), b.source.toBuffer());
  if (c !== 0) return c;
  if (a.classId !== b.classId) return a.classId - b.classId;
  return a.tranche - b.tranche;
}

/** The `LineRef` argument of Redeem, Return, Instant Redeem: `{ side, dueAt, class, tranche }` (the Source comes from the `source` account). */
export interface LineRef {
  side: number;
  dueAt: bigint;
  class: number;
  tranche: number;
}

export const lineRefOf = (l: LineKey): LineRef => ({ side: l.side, dueAt: l.dueAt, class: l.classId, tranche: l.tranche });

/** The Anchor-coder form of a `LineRef` (BN for the i64). */
export const sameKey = (a: LineKey, b: LineKey) => compareKeys(a, b) === 0;

export interface StoreHeader {
  version: number;
  bump: number;
  flags: number;
  len: number;
  first: number;
  account: PublicKey;
  ownTotal: bigint;
  wonTotal: bigint;
  feeTotal: bigint;
  reservedTotal: bigint;
  sponsoredLamports: bigint;
  ticketNeed: bigint;
  roomReserved: number;
  capacity: number;
}

export interface Store {
  header: StoreHeader;
  /** Lines in key order. */
  lines: Line[];
}

/** Decodes a basket or spill account (data WITH the 8-byte discriminator). */
export function decodeStore(data: Uint8Array): Store {
  if (data.length < DISC + HEADER_LEN) throw new Error("store account too short");
  const b = data.subarray(DISC);
  if (b[0] !== BASKET_VERSION) throw new Error(`unknown basket version ${b[0]}`);
  const len = rd32(b, 4);
  const first = rd32(b, 92);
  const capacity = Math.floor((b.length - HEADER_LEN) / LINE_LEN);
  if (first + len > capacity) throw new Error("store header contradicts its length");
  const header: StoreHeader = {
    version: b[0],
    bump: b[1],
    flags: b[2],
    len,
    first,
    account: new PublicKey(b.slice(8, 40)),
    ownTotal: rd64(b, 40),
    wonTotal: rd64(b, 48),
    feeTotal: rd64(b, 56),
    reservedTotal: rd64(b, 64),
    sponsoredLamports: rd64(b, 72),
    ticketNeed: rd64(b, 80),
    roomReserved: rd32(b, 88),
    capacity,
  };
  const lines: Line[] = [];
  for (let i = 0; i < len; i++) lines.push(decodeLine(b, HEADER_LEN + (first + i) * LINE_LEN));
  return { header, lines };
}

/** Lines of both stores in the draw's merged order. */
export function mergedLines(basket: Store, spill: Store | null): Line[] {
  const all = [...basket.lines, ...(spill?.lines ?? [])];
  return all.sort(compareKeys);
}

/** Playable Gemas in both stores (fee classes never count). */
export const playableTotal = (basket: Store, spill: Store | null): bigint =>
  basket.header.ownTotal + basket.header.wonTotal + (spill?.header.ownTotal ?? 0n) + (spill?.header.wonTotal ?? 0n);

/** Gemas an entry may draw now: playable minus Offer reservations minus an open Ticket's remaining need (`Pool::free`). */
export function freeGemas(basket: Store, spill: Store | null): bigint {
  const free = playableTotal(basket, spill) - basket.header.reservedTotal - basket.header.ticketNeed;
  return free > 0n ? free : 0n;
}

/** Rent-exempt lamports of one 144-byte slot at the default rate (3,480 lamports per byte-year x 2). */
export const LINE_RENT_LAMPORTS = 1_002_240n;
