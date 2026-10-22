/**
 * TypeScript port of the read side of tesoro_core `ledger/book`: what a basket line is worth now
 * (ready / unpaid), and what landing a Source's computed coverage would do to its classes.
 * Shares and checkpoint catch-up are not ported: the Wallet never shows them, and a Redeem
 * instruction computes them itself. All numbers are bigint; Gemas fixed point is 2^64.
 */

import { PublicKey } from "@solana/web3.js";
import { BOOK_AT, BOOK_FIXED_LEN, CLASS_GENERAL, CLASS_LEN, COUNTERS_AT, DISC, LINE_LEN, decodeLine, leBig, type Line } from "./basket";

export const FP_BITS = 64n;
export const FP_ONE = 1n << FP_BITS;
export const P_ONE = 1n << 96n;
export const P_MIN = 1n << 64n;
export const SCALE_BITS = 32n;
/** Dust a sync forgives (Fp), `DUST_FORGIVEN_FP`. */
export const DUST_FORGIVEN_FP = 1n << 40n;

export const fp = (gemas: bigint) => gemas << FP_BITS;
export const fpFloor = (v: bigint) => v >> FP_BITS;
export const fpCeil = (v: bigint) => (v >> FP_BITS) + (v & (FP_ONE - 1n) ? 1n : 0n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface ClassState {
  p: bigint;
  uncovered: bigint;
  ready: bigint;
  shares: bigint;
  w: bigint;
  scale: number;
  epoch: number;
  ck: number;
}

export interface SourceBookView {
  /** Coverage landed so far (Fp). */
  h: bigint;
  /** Ready released to the owner or cancelled (Fp). */
  r: bigint;
  ownerFp: bigint;
  ownerShares: bigint;
  takenFp: bigint;
  extensions: number;
  /** Classes in payout order: Platform, Studio, Leaderboard, General, Extension 1.. */
  classes: ClassState[];
  /** Fee counters (classes 0..2) when ever credited. */
  counters: (Line | null)[];
}

function decodeClass(raw: Uint8Array, at: number): ClassState {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    p: leBig(raw, at, 16),
    uncovered: leBig(raw, at + 16, 16),
    ready: leBig(raw, at + 32, 16),
    shares: leBig(raw, at + 48, 16),
    w: leBig(raw, at + 64, 16),
    scale: dv.getUint32(at + 112, true),
    epoch: dv.getUint32(at + 116, true),
    ck: dv.getUint32(at + 120, true),
  };
}

/** Decodes a Source book account (data with the discriminator). */
export function decodeBook(data: Uint8Array): SourceBookView {
  if (data.length < BOOK_AT + BOOK_FIXED_LEN) throw new Error("Source book too short");
  const b = data.subarray(BOOK_AT);
  if (b[0] !== 2) throw new Error(`unknown Source book version ${b[0]}`);
  const extensions = b[81];
  const count = 4 + extensions;
  if (b.length < BOOK_FIXED_LEN + count * CLASS_LEN) throw new Error("Source book shorter than its classes");
  const classes: ClassState[] = [];
  for (let i = 0; i < count; i++) classes.push(decodeClass(b, BOOK_FIXED_LEN + i * CLASS_LEN));
  const counters: (Line | null)[] = [];
  for (let c = 0; c < 3; c++) {
    const line = decodeLine(data, COUNTERS_AT + c * LINE_LEN);
    counters.push(line.p === 0n ? null : line);
  }
  return { h: leBig(b, 1, 16), r: leBig(b, 17, 16), ownerFp: leBig(b, 33, 16), ownerShares: leBig(b, 49, 16), takenFp: leBig(b, 65, 16), extensions, classes, counters };
}

/** `ClassState::view_exact`: the line's unpaid amount now (Fp), rounded up. */
export function uncoveredNow(c: ClassState, line: Pick<Line, "uncovered" | "epoch" | "scale" | "p">): bigint {
  if (line.uncovered === 0n || line.epoch < c.epoch) return 0n;
  if (line.epoch > c.epoch || line.scale > c.scale || line.p === 0n) throw new Error("line snapshot is ahead of its class");
  const diff = BigInt(c.scale - line.scale);
  if (diff === 0n && c.p === line.p) return line.uncovered;
  if (diff === 0n && c.p > line.p) throw new Error("line snapshot is ahead of its class");
  const q = ceilDiv(line.uncovered * c.p, line.p);
  const v = ceilDiv(q, 1n << (SCALE_BITS * diff));
  if (v > line.uncovered) throw new Error("line snapshot is ahead of its class");
  return v;
}

/** Ready of a line now (Fp). */
export function readyNow(book: SourceBookView, line: Line): bigint {
  const c = book.classes[line.classId];
  if (!c) throw new Error("no such class");
  return fp(line.amount) - uncoveredNow(c, line);
}

/** Whole Gemas the line could Redeem against the book as it stands. */
export const redeemableNow = (book: SourceBookView, line: Line): bigint => fpFloor(readyNow(book, line));

/** Left to pay back over all classes of the book, Fp. */
export const uncoveredTotal = (book: SourceBookView): bigint => book.classes.reduce((a, c) => a + c.uncovered, 0n);

/** One class after landing `d` (`0 < d <= uncovered`), shares ignored. Mirrors `ClassState::land`. */
function landClass(c: ClassState, d: bigint): ClassState {
  const next = { ...c, ready: c.ready + d };
  if (d === c.uncovered) {
    return { ...next, uncovered: 0n, epoch: c.epoch + 1, scale: 0, p: P_ONE, w: 0n, ck: c.ck + 1 };
  }
  let { p, scale, ck } = next;
  while (p < P_MIN) {
    p <<= SCALE_BITS;
    scale += 1;
    ck += 1;
  }
  const w = c.w;
  const rest = w - d;
  const n = p * rest;
  let newP: bigint;
  let extra: bigint;
  if (n < P_MIN * w) {
    const shifted = n << SCALE_BITS;
    const qt = shifted / w;
    const r = shifted % w;
    newP = r !== 0n ? qt + 1n : qt;
    const once = ceilDiv(w, p);
    extra = r === 0n ? 0n : (once >> SCALE_BITS) + ((once & 0xffff_ffffn) !== 0n ? 1n : 0n);
    scale += 1;
    ck += 1;
  } else {
    const qt = n / w;
    const r = n % w;
    newP = r !== 0n ? qt + 1n : qt;
    extra = r === 0n ? 0n : ceilDiv(w, p);
  }
  return { ...next, p: newP, scale, ck, w: rest + extra, uncovered: c.uncovered - d };
}

/**
 * The book after landing the coverage `target` (Fp, cumulative) would give, classes paid in order
 * (`SourceBook::land`, shares left out). A target at or below `h` lands nothing.
 */
export function landPreview(book: SourceBookView, target: bigint): SourceBookView {
  const delta = target > book.h ? target - book.h : 0n;
  if (delta === 0n) return book;
  let rest = delta;
  const classes = book.classes.map((c) => {
    if (rest === 0n || c.uncovered === 0n) return c;
    const d = rest < c.uncovered ? rest : c.uncovered;
    rest -= d;
    return landClass(c, d);
  });
  return { ...book, h: target, ownerFp: book.ownerFp + rest, classes };
}

/**
 * The coverage target `sync_source` lands: the open Advance's `counted` source units at the
 * Source's price, with the dust forgiveness. `unitNum`/`unitDen`: base units per Gema = num/den.
 */
export function syncTarget(book: SourceBookView, countedUnits: bigint, unit: { unitNum: bigint; unitDen: bigint }): bigint {
  if (unit.unitNum === 0n) return book.h;
  let target = (countedUnits * (unit.unitDen << FP_BITS)) / unit.unitNum;
  const full = book.h + uncoveredTotal(book);
  if (target < full && full - target <= DUST_FORGIVEN_FP) target = full;
  return target;
}

/** The book with the open Advance's coverage landed at the clock. */
export function syncPreview(book: SourceBookView, countedUnits: bigint, unit: { unitNum: bigint; unitDen: bigint }): SourceBookView {
  return landPreview(book, syncTarget(book, countedUnits, unit));
}

/** Gemas still to be repaid on a Source after a sync (Left to pay back), rounded up. */
export const debtGemasOf = (book: SourceBookView): bigint => fpCeil(uncoveredTotal(book));

/** True for the classes holders can Redeem (General and Extensions); fee classes are Tesoro's, the Studio's and the Leaderboard's. */
export const isHolderClass = (classId: number) => classId >= CLASS_GENERAL;

export const SOURCE_KEY = (k: PublicKey) => k.toBase58();
export { DISC };
