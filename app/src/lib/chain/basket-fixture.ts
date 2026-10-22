/**
 * Byte encoders for baskets, spills and Source books, the mirror of the decoders in basket.ts and
 * book.ts. For tests, Storybook and fixtures: the program never reads what these write.
 */

import { PublicKey } from "@solana/web3.js";
import { BASKET_VERSION, BOOK_AT, BOOK_FIXED_LEN, CLASS_LEN, COUNTERS_AT, CLASS_GENERAL, DISC, HEADER_LEN, LINE_LEN, compareKeys, type Line } from "./basket";
import { P_ONE, type ClassState } from "./book";

function putBig(out: Uint8Array, at: number, len: number, v: bigint) {
  for (let i = 0; i < len; i++) {
    out[at + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export function lineOf(p: Partial<Line> & Pick<Line, "source" | "amount">): Line {
  return { side: 0, classId: CLASS_GENERAL, tranche: 0, dueAt: 0n, uncovered: 0n, p: P_ONE, scale: 0, epoch: 0, ck: 0, shares: 0n, ...p };
}

export function encodeLine(l: Line, out: Uint8Array, at = 0) {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out.fill(0, at, at + LINE_LEN);
  out[at] = l.side;
  out[at + 1] = l.classId;
  out[at + 2] = l.tranche;
  dv.setBigInt64(at + 3, l.dueAt, true);
  out.set(l.source.toBytes(), at + 11);
  dv.setBigUint64(at + 43, l.amount, true);
  putBig(out, at + 51, 16, l.uncovered);
  putBig(out, at + 67, 16, l.p);
  dv.setUint32(at + 83, l.scale, true);
  dv.setUint32(at + 87, l.epoch, true);
  dv.setUint32(at + 91, l.ck, true);
  putBig(out, at + 95, 16, l.shares);
}

export interface StoreOptions {
  account?: PublicKey;
  capacity?: number;
  first?: number;
  flags?: number;
  reservedTotal?: bigint;
  ticketNeed?: bigint;
  roomReserved?: number;
}

/** A basket / spill account's data (with discriminator) holding `lines`, which are sorted here. */
export function encodeStore(lines: Line[], o: StoreOptions = {}): Buffer {
  const sorted = [...lines].sort(compareKeys);
  const first = o.first ?? 0;
  const capacity = Math.max(o.capacity ?? sorted.length + first, sorted.length + first);
  const data = new Uint8Array(DISC + HEADER_LEN + capacity * LINE_LEN);
  const b = data.subarray(DISC);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  b[0] = BASKET_VERSION;
  b[2] = o.flags ?? 0;
  dv.setUint32(4, sorted.length, true);
  b.set((o.account ?? PublicKey.default).toBytes(), 8);
  let own = 0n;
  let won = 0n;
  let fee = 0n;
  for (const l of sorted) {
    if (l.classId < CLASS_GENERAL) fee += l.amount;
    else if (l.side === 0) own += l.amount;
    else won += l.amount;
  }
  dv.setBigUint64(40, own, true);
  dv.setBigUint64(48, won, true);
  dv.setBigUint64(56, fee, true);
  dv.setBigUint64(64, o.reservedTotal ?? 0n, true);
  dv.setBigUint64(80, o.ticketNeed ?? 0n, true);
  dv.setUint32(88, o.roomReserved ?? 0, true);
  dv.setUint32(92, first, true);
  sorted.forEach((l, i) => encodeLine(l, b, HEADER_LEN + (first + i) * LINE_LEN));
  return Buffer.from(data);
}

export function freshClass(): ClassState {
  return { p: P_ONE, uncovered: 0n, ready: 0n, shares: 0n, w: 0n, scale: 0, epoch: 0, ck: 0 };
}

/** A Source book account's data (with discriminator). `classes` are Platform, Studio, Leaderboard, General, Extension 1..; fewer than four are padded with fresh ones. */
export function encodeBook(classes: ClassState[], head: { h?: bigint; r?: bigint } = {}, counters: (Line | null)[] = []): Buffer {
  const all = [...classes];
  while (all.length < 4) all.push(freshClass());
  const ext = all.length - 4;
  const data = new Uint8Array(BOOK_AT + BOOK_FIXED_LEN + all.length * CLASS_LEN);
  const b = data.subarray(BOOK_AT);
  b[0] = 2;
  putBig(b, 1, 16, head.h ?? 0n);
  putBig(b, 17, 16, head.r ?? 0n);
  b[81] = ext;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  all.forEach((c, i) => {
    const at = BOOK_FIXED_LEN + i * CLASS_LEN;
    putBig(b, at, 16, c.p);
    putBig(b, at + 16, 16, c.uncovered);
    putBig(b, at + 32, 16, c.ready);
    putBig(b, at + 48, 16, c.shares);
    putBig(b, at + 64, 16, c.w);
    dv.setUint32(at + 112, c.scale, true);
    dv.setUint32(at + 116, c.epoch, true);
    dv.setUint32(at + 120, c.ck, true);
  });
  counters.forEach((l, i) => l && encodeLine(l, data, COUNTERS_AT + i * LINE_LEN));
  return Buffer.from(data);
}
