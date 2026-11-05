import { PublicKey } from "@solana/web3.js";

// The browser's Buffer polyfill has no BigInt readers, so 64-bit fields go through a DataView.
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (b: Uint8Array, at: number) => dv(b).getBigUint64(at, true);
const i64 = (b: Uint8Array, at: number) => dv(b).getBigInt64(at, true);

// ---- Line stores (baskets, spills, Tickets, Pots) ---------------------------------------------------------------

/** Most lines a basket, and a spill, can hold (storage.rs `MAX_BASKET_LINES` / `MAX_SPILL_LINES`). */
export const MAX_STORE_LINES = 32_768;
export const DISC = 8;
export const STORE_HEADER = 128;
export const LINE_LEN = 144;
/** A Ticket or Pot account: 8 B discriminator, a 192 B head, then a line store. */
export const TICKET_HEAD = 192;
/** `pots::TICKET_VERSION`: the head layout below. */
export const TICKET_VERSION = 2;
export const POT_AT = DISC + TICKET_HEAD;

/** One store line, the parts of its 144 bytes the keeper needs (the key, and the whole Gemas). */
export interface StoreLine {
  side: number;
  cls: number;
  tranche: number;
  dueAt: bigint;
  source: PublicKey;
  amount: bigint;
}

export interface Store {
  account: PublicKey;
  len: number;
  first: number;
  capacity: number;
  /** Slots held back for Matches in flight (a spill's header; baskets keep 0). */
  roomReserved: number;
  /** Whole Gemas in the store, own + won + fee. */
  lineAt(i: number): StoreLine;
  lines(): StoreLine[];
}

/** Wraps a line store whose body starts at `bodyAt` of the account data (8 for a basket or spill, `POT_AT` for a Pot). */
export function decodeStore(data: Uint8Array, bodyAt = DISC): Store {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const body = buf.subarray(bodyAt);
  if (body.length < STORE_HEADER) throw new Error("not a line store: too short");
  const len = body.readUInt32LE(4);
  const first = body.readUInt32LE(92);
  const capacity = Math.floor((body.length - STORE_HEADER) / LINE_LEN);
  if (first + len > capacity) throw new Error("not a line store: len beyond capacity");
  const lineAt = (i: number): StoreLine => {
    if (i < 0 || i >= len) throw new RangeError(`line ${i} of ${len}`);
    const at = STORE_HEADER + (first + i) * LINE_LEN;
    return {
      side: body[at],
      cls: body[at + 1],
      tranche: body[at + 2],
      dueAt: i64(body, at + 3),
      source: new PublicKey(body.subarray(at + 11, at + 43)),
      amount: u64(body, at + 43),
    };
  };
  return {
    account: new PublicKey(body.subarray(8, 40)),
    len,
    first,
    capacity,
    roomReserved: body.readUInt32LE(88),
    lineAt,
    lines: () => Array.from({ length: len }, (_, i) => lineAt(i)),
  };
}

/** Slots an Account can still take: free slots of basket and spill, minus the ones held for Matches in flight. */
export const slack = (basket: Store, spill: Store) => basket.capacity - basket.len + (spill.capacity - spill.len) - spill.roomReserved;

// ---- Tickets -----------------------------------------------------------------------------------------------------

export type TicketState = "open" | "cancelling" | "closed" | "cancelled";
const TICKET_STATES: TicketState[] = ["open", "cancelling", "closed", "cancelled"];

export interface TicketFacts {
  kind: "entry" | "backing";
  state: TicketState;
  account: PublicKey;
  game: PublicKey;
  payer: PublicKey;
  nonce: bigint;
  target: bigint;
  expiresAt: number;
  spillRoom: number;
  /** The seat key that co-signed `open_ticket` (the default key for a Pot made by a direct draw). */
  signer: PublicKey;
}

/** The head of a Ticket account (offsets in programs/tesoro_core/src/pots.rs). */
export function decodeTicketHead(data: Uint8Array): TicketFacts {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < DISC + TICKET_HEAD) throw new Error("not a Ticket: too short");
  const h = buf.subarray(DISC, DISC + TICKET_HEAD);
  const state = TICKET_STATES[h[3]];
  if (!state || h[2] > 1) throw new Error("not a Ticket: bad head");
  return {
    kind: h[2] === 0 ? "entry" : "backing",
    state,
    account: new PublicKey(h.subarray(8, 40)),
    game: new PublicKey(h.subarray(40, 72)),
    payer: new PublicKey(h.subarray(72, 104)),
    nonce: u64(h, 104),
    target: u64(h, 112),
    expiresAt: Number(i64(h, 120)),
    spillRoom: h.readUInt32LE(132),
    signer: new PublicKey(h.subarray(152, 184)),
  };
}
