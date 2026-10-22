import "./polyfill";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { BASKET_VERSION, DISC, TESORO_CORE, basketPda, decodeStore, matchPda, spillPda } from "./basket";
import { coreIx, metaOf } from "./core-ix";

/**
 * Overflow records (tesoro_core `instructions/overflow.rs`): the Gemas of a win, a refund, a Season prize or a Studio Fee that
 * did not fit in an Account's stores wait in a record until there is room. Anyone may move them in (`claim_overflow`); the
 * rent goes back to whoever paid it. Pure byte decoders and the instruction builder; no network calls.
 *
 * Layout: 8 B discriminator, head (payer 32, kind 1, id 40), then a basket-format line store whose header holds the owner.
 */

/** `sha256("account:OverflowHead")[..8]`: an Anchor discriminator, not in the IDL (no instruction names the account type). */
export const OVERFLOW_DISC = Uint8Array.from([191, 210, 201, 203, 240, 85, 28, 12]);
/** Where the line store of a record starts. */
export const OVERFLOW_STORE_AT = DISC + 32 + 1 + 40;
/** Where the owner Account's key sits in a record (the store header keeps it 8 bytes in): the memcmp offset for a list by owner. */
export const OVERFLOW_OWNER_AT = OVERFLOW_STORE_AT + 8;
/** The record address of `owner` for a Match: `["overflow", owner, kind, id[..32], id[32..]]`, id = the opener's Account then n (LE). */
export function matchOverflowPda(owner: PublicKey, m: { opener: PublicKey; n: bigint | number }): PublicKey {
  const id = new Uint8Array(40);
  id.set(m.opener.toBytes(), 0);
  new DataView(id.buffer).setBigUint64(32, BigInt(m.n), true);
  return PublicKey.findProgramAddressSync([Buffer.from("overflow"), owner.toBuffer(), Buffer.from([OVERFLOW_KINDS.match]), id.slice(0, 32), id.slice(32)], TESORO_CORE)[0];
}

/** Lines one claim moves. */
export const CLAIM_LINES = 4;

export const OVERFLOW_KINDS = { match: 0, season: 1, route: 2 } as const;

/** Gemas of one record that wait for room. */
export interface WaitingRecord {
  address: PublicKey;
  /** The Account the Gemas belong to. */
  owner: PublicKey;
  /** Who paid the record's rent; the claim returns it there. */
  payer: PublicKey;
  kind: number;
  /** The Match account of a Match record: a claim names it so the record closes once the Match is gone. */
  match: PublicKey | null;
  gemas: bigint;
  lines: number;
  /** The Sources of the lines: a claim that merges into a line the owner holds needs their books. */
  sources: PublicKey[];
}

/** A record read from its account data, or null when the bytes are not a record (another layout, a closed account). */
export function decodeOverflowRecord(address: PublicKey, data: Uint8Array): WaitingRecord | null {
  try {
    if (data.length < OVERFLOW_STORE_AT + 128) return null;
    for (let i = 0; i < DISC; i++) if (data[i] !== OVERFLOW_DISC[i]) return null;
    // the store decoder wants "discriminator + header + lines": the record without its head
    const joined = new Uint8Array(DISC + data.length - OVERFLOW_STORE_AT);
    joined.set(data.subarray(0, DISC), 0);
    joined.set(data.subarray(OVERFLOW_STORE_AT), DISC);
    if (joined[DISC] !== BASKET_VERSION) return null;
    const store = decodeStore(joined);
    return {
      address,
      owner: store.header.account,
      payer: new PublicKey(data.slice(DISC, DISC + 32)),
      kind: data[DISC + 32],
      match: data[DISC + 32] === OVERFLOW_KINDS.match ? matchPda(new PublicKey(data.slice(DISC + 33, DISC + 65)), new DataView(data.buffer, data.byteOffset + DISC + 65, 8).getBigUint64(0, true)) : null,
      gemas: store.lines.reduce((t, l) => t + l.amount, 0n),
      lines: store.lines.length,
      sources: [...new Map(store.lines.map((l) => [l.source.toBase58(), l.source])).values()],
    };
  } catch {
    return null;
  }
}

/** Total Gemas waiting for room across records. */
export const waitingGemas = (records: readonly Pick<WaitingRecord, "gemas">[]): bigint => records.reduce((t, r) => t + r.gemas, 0n);

/**
 * `claim_overflow`: moves up to `CLAIM_LINES` lines of the record into the owner's stores. `books` are the Source books (and
 * checkpoint pages) of lines that merge into a line the owner already holds.
 */
export function claimOverflowIx(record: Pick<WaitingRecord, "address" | "owner" | "payer" | "match">, books: PublicKey[] = []): TransactionInstruction {
  return coreIx(
    "claim_overflow",
    { account: record.owner, basket: basketPda(record.owner), spill: spillPda(record.owner), record: record.address, payer: record.payer },
    { max: CLAIM_LINES },
    [...books.map((k) => metaOf(k, true)), ...(record.match ? [metaOf(record.match, false)] : [])],
  );
}
