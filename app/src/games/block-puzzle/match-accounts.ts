/**
 * Addresses and byte readers for a Match on tesoro_core's baskets, Tickets and chunks
 * (docs/adr/0013, economy-notes/matching-api.md). Pure: no RPC, so the layouts are testable.
 */
import { PublicKey } from "@solana/web3.js";
import { TESORO_CORE_ID, pda, protectionsPda } from "../../lib/chain/native";

const s = (v: string) => Buffer.from(v);
const le8 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** `["match", opener Account, n]`: the Match id is the opener's own counter. */
export const matchAddress = (openerAccount: PublicKey, n: bigint | number) => pda([s("match"), openerAccount.toBuffer(), le8(n)]);
export const countersPda = (account: PublicKey) => pda([s("counters"), account.toBuffer()]);
export const economyPda = () => pda([s("economy")]);
export const basketPda = (account: PublicKey) => pda([s("basket"), account.toBuffer()]);
export const spillPda = (account: PublicKey) => pda([s("spill"), account.toBuffer()]);
/** An Entry or Backing Ticket, then that side's Pot: `["ticket", account, nonce]`. */
export const ticketPda = (account: PublicKey, nonce: bigint | number) => pda([s("ticket"), account.toBuffer(), le8(nonce)]);
/** Written when a settlement or refund starts: `["settled", match]`. */
export const receiptPda = (match: PublicKey) => pda([s("settled"), match.toBuffer()]);
export const sponsorPda = () => pda([s("sponsor")]);
export const bookPda = (source: PublicKey) => pda([s("book"), source.toBuffer()]);
export const checkpointPda = (source: PublicKey, cls: number, page: number) => {
  const p = Buffer.alloc(4);
  p.writeUInt32LE(page);
  return pda([s("ckpt"), source.toBuffer(), Buffer.from([cls]), p]);
};
export const eventAuthorityPda = (program: PublicKey = TESORO_CORE_ID) => pda([s("__event_authority")], program);
export { protectionsPda };

/** Checkpoint pages a book can have: classes 0..14, pages 0..3 (the candidates to look for). */
export const CHECKPOINT_CLASSES = 15;
export const CHECKPOINT_PAGES = 4;
export const checkpointCandidates = (source: PublicKey) => {
  const out: PublicKey[] = [];
  for (let c = 0; c < CHECKPOINT_CLASSES; c++) for (let p = 0; p < CHECKPOINT_PAGES; p++) out.push(checkpointPda(source, c, p));
  return out;
};

// ---- Ticket / Pot account bytes -------------------------------------------------------------

const DISC = 8;
const TICKET_HEAD_LEN = 160;
/** Where the line store starts in a Ticket (and so a Pot) account. */
export const POT_AT = DISC + TICKET_HEAD_LEN;
const HEADER_LEN = 128;
const LINE_LEN = 144;

export interface PotLine {
  side: number;
  class: number;
  tranche: number;
  dueAt: bigint;
  source: PublicKey;
  amount: bigint;
}

/** The live lines of a line store whose body starts at `at` (a basket, a spill, or a Pot). */
export function decodeLines(data: Uint8Array, at: number): PotLine[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < at + HEADER_LEN) throw new Error("not a line store");
  const len = buf.readUInt32LE(at + 4);
  const first = buf.readUInt32LE(at + 92);
  const out: PotLine[] = [];
  for (let i = first; i < first + len; i++) {
    const o = at + HEADER_LEN + i * LINE_LEN;
    if (o + LINE_LEN > buf.length) throw new Error("line store shorter than its length");
    out.push({
      side: buf[o],
      class: buf[o + 1],
      tranche: buf[o + 2],
      dueAt: buf.readBigInt64LE(o + 3),
      source: new PublicKey(buf.subarray(o + 11, o + 43)),
      amount: buf.readBigUInt64LE(o + 43),
    });
  }
  return out;
}

/** Gemas a Ticket or Pot holds (own plus won). */
export function potTotal(data: Uint8Array): bigint {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buf.readBigUInt64LE(POT_AT + 40) + buf.readBigUInt64LE(POT_AT + 48);
}

/** Lines a Ticket or Pot holds. */
export const potLineCount = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt32LE(POT_AT + 4);

/** Who paid the rent of a Ticket/Pot (it goes back there at close). */
export const potPayer = (data: Uint8Array) => new PublicKey(Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(DISC + 72, DISC + 104));

/** Rent a sponsor fronted for the Ticket/Pot (returned to the sponsor first at close). */
export const potSponsored = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(DISC + 144);

/**
 * Every distinct Source with Gemas left in the given Pots, in line order. A settlement chunk needs
 * the books of the Sources of its next steps; naming all of them is a superset of
 * `MatchRecord::sources_ahead`, which is fine for the small Pots of one entry. A Pot of many
 * Sources needs the keeper's exact walk (ticket 19) and a lookup table (ticket 18).
 */
export function potSources(pots: (Uint8Array | null)[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const pot of pots) {
    if (!pot) continue;
    for (const l of decodeLines(pot, POT_AT)) {
      if (l.amount === 0n) continue;
      const k = l.source.toBase58();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l.source);
    }
  }
  return out;
}

/** Matches of one Account that can be open at once (tesoro_core MAX_OPEN_MATCHES). */
export const MAX_OPEN_MATCHES = 8;
/** Lines a direct draw into a fresh Pot may take (tesoro_core MAX_DIRECT_LINES). */
export const MAX_DIRECT_LINES = 16;
/** Steps one `match_chunk` may take (tesoro_core MAX_CHUNK_STEPS). */
export const MAX_CHUNK_STEPS = 12;
/** `stage_entry` operations per call (tesoro_core MAX_STAGE_OPS). */
export const MAX_STAGE_OPS = 32;

/** Stage names as Anchor decodes the `Stage` enum. */
export type MatchStage = "open" | "active" | "settling" | "refunding" | "closed";
export const stageOf = (stage: Record<string, unknown>): MatchStage => Object.keys(stage)[0].toLowerCase() as MatchStage;
